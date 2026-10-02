import {createHash} from 'node:crypto';
import * as v from './validation.mjs';
import {initializeHostTurnJournal,createHostTurnJournal} from './host-turn-journal.mjs';
import {publicReceipt} from './receipt.mjs';
import {createResidentChatAdapter} from './resident-chat-adapter.mjs';
import {RESIDENT_TOOLS,RESIDENT_LIMITS,emptyResidentResult,protectedInstructions,runResidentTurn} from './resident-turn-runner.mjs';

const hash = input=>createHash('sha256').update(input).digest('hex');
const deniedMask=()=>({pause:false,resume:false,return:false});
const schema=`CREATE TABLE IF NOT EXISTS resident_session_visits_v1 (
  session_hash TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch>=0)
) STRICT;
CREATE TABLE IF NOT EXISTS resident_turn_bindings_v1 (
  actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, session_hash TEXT NOT NULL,
  visit_epoch INTEGER NOT NULL CHECK(visit_epoch>=0), room_id TEXT NOT NULL, bot_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=0), message_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL, PRIMARY KEY(actor_id,operation_id)
) STRICT, WITHOUT ROWID;`;
const canonical=sql=>sql.replace(/IF NOT EXISTS\s+/i,'').replace(/\s+/g,'').replace(/;$/,'');
const expected=new Map(schema.split(/;\s*/).filter(Boolean).map(sql=>[sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)[1],canonical(sql)]));
function exact(value,keys){v.record(value);if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))v.fail(400,'RESIDENT_INVALID_FIELDS','Use the exact resident test request fields');}
function autocommit(store){if(store.db.isTransaction)v.fail(503,'TURN_JOURNAL_OUTER_TRANSACTION','Resident turns require committed host storage');}
function checkSchema(store){for(const[name,sql]of expected){const found=store.get('SELECT sql FROM main.sqlite_schema WHERE type=? AND name=?','table',name);if(!found||canonical(found.sql)!==sql)throw Object.assign(new Error('Resident turn storage must be explicitly initialized'),{code:'RESIDENT_STORAGE_NOT_INITIALIZED'});}}
/** Explicit migration only; never changes host SQLite policy or opens another DB. */
export function initializeResidentTurnStorage({store}){
  autocommit(store);initializeHostTurnJournal({database:store.db});
  store.transaction(()=>{store.db.exec(schema.replaceAll('CREATE TABLE IF NOT EXISTS ','CREATE TABLE IF NOT EXISTS main.'));checkSchema(store);});
}
export function unavailableResidentTest(){return{available:false,mode:'unavailable',toolMask:deniedMask(),limits:{...RESIDENT_LIMITS}};}

/** Trusted factory configuration only. Nothing is read from env, a room or a request. */
export function createResidentTurnService({store,bots,session,body,send,now=Date.now,options}){
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['initializeJournal','provider','toolMask'].includes(k)))throw new Error('Invalid residentTurnOptions');
  if(options.initializeJournal!==undefined&&typeof options.initializeJournal!=='boolean')throw new Error('Invalid resident journal initialization flag');
  const mask=deniedMask();
  if(options.toolMask!==undefined){exact(options.toolMask,RESIDENT_TOOLS);for(const name of RESIDENT_TOOLS){if(typeof options.toolMask[name]!=='boolean')throw new Error('Invalid resident tool mask');mask[name]=options.toolMask[name];}}
  if(options.initializeJournal===true)initializeResidentTurnStorage({store});
  checkSchema(store);
  const journal=createHostTurnJournal({database:store.db});
  // Journal attachment and all durability checks precede provider attachment.
  let adapter;try{adapter=options.provider===undefined?null:createResidentChatAdapter(options.provider);}catch(error){journal.close();throw error;}
  const active=new Map(),rates=new Map();let closing=false,closed=false;
  const key=b=>JSON.stringify([b.actor_id,b.operation_id]);
  const identity=b=>({actorId:b.actor_id,turnId:b.operation_id,fingerprint:b.fingerprint});
  function authorize(roomId,actorId){
    const {row}=store.authorize(roomId,actorId),role=store.worldRole(store.worldRow(row.world_id),actorId);
    if(!['owner','admin','editor'].includes(role))v.fail(403,'BOT_FORBIDDEN','Only the universe owner or a world admin/editor can test residents');
    return row;
  }
  function botRow(roomId,botId){const row=store.get('SELECT * FROM room_bots WHERE id=? AND room_id=? AND deleted_at IS NULL',botId,roomId);if(!row)v.fail(404,'BOT_NOT_FOUND','Resident is unavailable');return row;}
  function assertScope(b){
    if(closed)v.fail(503,'RESIDENT_CLOSED');
    const current=store.get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?',b.session_hash,now());
    if(!current||current.user_id!==b.actor_id)v.fail(401,'AUTH_REQUIRED','Sign in again');
    if(current.current_room_id!==b.room_id||store.get('SELECT epoch FROM main.resident_session_visits_v1 WHERE session_hash=?',b.session_hash)?.epoch!==b.visit_epoch)v.fail(409,'RESIDENT_SCOPE_CHANGED','The room visit changed');
    authorize(b.room_id,b.actor_id);
    const row=botRow(b.room_id,b.bot_id),config=JSON.parse(row.config);
    if(row.revision!==b.revision)v.fail(409,'BOT_REVISION_CONFLICT','This resident changed; review the saved configuration');
    if(!config.enabled)v.fail(409,'BOT_DISABLED','Enable this resident before testing');
    if(!config.respondToPlayers)v.fail(409,'BOT_RESPONSE_DISABLED','Enable Respond to players before testing');
    return config;
  }
  function scope(req,userId,roomId,botId,revision){
    const s=session(req);if(s.user_id!==userId)v.fail(401,'AUTH_REQUIRED');authorize(roomId,userId);
    if(!s.token_hash||s.current_room_id!==roomId)v.fail(403,'JOIN_REQUIRED','Join this room before testing');
    autocommit(store);store.run('DELETE FROM main.resident_session_visits_v1 WHERE session_hash NOT IN (SELECT token_hash FROM sessions WHERE expires_at>?)',now());store.run('INSERT OR IGNORE INTO main.resident_session_visits_v1(session_hash,epoch) VALUES(?,0)',s.token_hash);
    const row=botRow(roomId,botId);
    const bound={actor_id:userId,session_hash:s.token_hash,visit_epoch:store.get('SELECT epoch FROM main.resident_session_visits_v1 WHERE session_hash=?',s.token_hash).epoch,room_id:roomId,bot_id:botId,revision:revision??row.revision};
    assertScope(bound);return bound;
  }
  function actorJournal(b,config){return journal.forActor({actorId:b.actor_id,authorize:()=>{assertScope(b);return true;},protectedText:protectedInstructions(config.privateInstructions??'')});}
  function envelope(b,status,result=null,{duplicate=false,cancelRequested=false}={}){return{operationId:b.operation_id,roomId:b.room_id,botId:b.bot_id,revision:b.revision,status,result,duplicate,cancelRequested};}
  function known(b,storage,{duplicate=false}={}){
    assertScope(b);const lookup=storage.lookup(identity(b));
    if(lookup.status==='replay')return envelope(b,lookup.result.status,lookup.result,{duplicate});
    const live=active.get(key(b));
    if(lookup.status==='pending'&&live)return envelope(b,'pending',null,{duplicate,cancelRequested:live.cancelRequested});
    if(lookup.status==='pending')return envelope(b,'uncertain',emptyResidentResult('uncertain','TURN_OUTCOME_UNKNOWN'),{duplicate});
    return null;
  }
  function currentBinding(req,userId,roomId,botId,operationId){
    scope(req,userId,roomId,botId);
    const b=store.get('SELECT * FROM main.resident_turn_bindings_v1 WHERE actor_id=? AND operation_id=?',userId,operationId);
    if(!b||b.room_id!==roomId||b.bot_id!==botId)v.fail(404,'RESIDENT_TURN_NOT_FOUND');
    const s=session(req);if(b.session_hash!==s.token_hash)v.fail(403,'RESIDENT_SESSION_MISMATCH','This test belongs to another session');
    return{b,config:assertScope(b)};
  }
  function budget(userId){
    const t=now();for(const[id,r]of rates)if(t-r.start>=60000)rates.delete(id);
    if(active.size>=4||[...active.values()].some(r=>r.binding.actor_id===userId))v.fail(429,'RESIDENT_CONCURRENCY_LIMIT','Wait for the current test to finish');
    const r=rates.get(userId);if(r&&r.count>=6)v.fail(429,'RESIDENT_RATE_LIMIT','Wait before starting another test');
    rates.set(userId,r?{...r,count:r.count+1}:{start:t,count:1});
  }
  function start(b,config,message,storage){
    const controller=new AbortController(),entry={binding:b,controller,cancelRequested:false,promise:null};active.set(key(b),entry);
    const effective=Object.fromEntries(RESIDENT_TOOLS.map(name=>[name,mask[name]&&config.modelPermissions?.[name]===true&&config.permissions?.[name]===true]));
    entry.promise=(async()=>{
      const result=await runResidentTurn({adapter,actorId:b.actor_id,operationId:b.operation_id,message,instructions:config.privateInstructions??'',toolMask:effective,signal:controller.signal,authorize:()=>{assertScope(b);storage.lookup(identity(b));},executeCommand:command=>{
        assertScope(b);storage.lookup(identity(b));return bots.command({...command,userId:b.actor_id,roomId:b.room_id,id:b.bot_id,guard:()=>assertScope(b)});
      }});
      // Loss of authorization deliberately leaves a durable pending/uncertain record.
      // No raw error, prompt, or provider response is published or logged.
      try{assertScope(b);storage.finish({...identity(b),result});}catch{}
    })().finally(()=>active.delete(key(b)));
    entry.promise.catch(()=>{});
  }
  async function handle({req,res,path,method,userId}){
    const match=path.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/bots\/([A-Za-z0-9_-]+)\/turns(?:\/([A-Za-z0-9_-]+))?(?:\/(cancel))?$/);if(!match)return false;
    if(closing||closed)v.fail(503,'RESIDENT_CLOSED');
    const[,roomId,botId,operationId,action]=match;authorize(roomId,userId);
    try{
      if(method==='POST'&&!operationId&&!action){
        // Capture before consuming the body: leave/rejoin while streaming cannot retarget it.
        const before=scope(req,userId,roomId,botId),input=await body(req);exact(input,['clientOperationId','revision','message']);
        v.id(input.clientOperationId,'clientOperationId');v.integer(input.revision,'revision');const message=v.text(input.message,'message',RESIDENT_LIMITS.maxInputChars);
        const bound=scope(req,userId,roomId,botId,input.revision);if(bound.session_hash!==before.session_hash||bound.visit_epoch!==before.visit_epoch)v.fail(409,'RESIDENT_SCOPE_CHANGED');
        const b={...bound,operation_id:input.clientOperationId,message_hash:hash(input.message)};
        b.fingerprint=hash(JSON.stringify([b.actor_id,b.operation_id,b.session_hash,b.visit_epoch,b.room_id,b.bot_id,b.revision,b.message_hash]));
        const old=store.get('SELECT * FROM main.resident_turn_bindings_v1 WHERE actor_id=? AND operation_id=?',userId,b.operation_id);
        if(old&&old.fingerprint!==b.fingerprint)v.fail(409,'OPERATION_REUSED','Use a new operation ID for a different test or visit');
        const config=assertScope(b),storage=actorJournal(b,config),prior=known(b,storage,{duplicate:true});
        if(prior){send(res,prior.status==='pending'?202:200,prior);return true;}
        if(!adapter)v.fail(503,'RESIDENT_PROVIDER_UNAVAILABLE','No local test provider is configured');
        if(!message.isWellFormed()||!String(config.privateInstructions??'').isWellFormed()||Buffer.byteLength(config.privateInstructions??'')>8192)v.fail(422,'RESIDENT_CONTEXT_LIMIT','Private instructions must fit the local test provider UTF-8 limit');
        try{publicReceipt(emptyResidentResult('filtered','RESIDENT_OUTPUT_FILTERED'),{maxReceiptBytes:65536,protectedText:protectedInstructions(config.privateInstructions??'')});}catch{v.fail(422,'RESIDENT_CONTEXT_UNREPRESENTABLE','Private instructions conflict with safe receipt metadata');}
        budget(userId);autocommit(store);
        if(!old)store.transaction(()=>{assertScope(b);if(store.get('SELECT COUNT(*) n FROM main.resident_turn_bindings_v1').n>=10000)v.fail(503,'RESIDENT_CAPACITY','The durable test journal is full');store.run('INSERT INTO main.resident_turn_bindings_v1(actor_id,operation_id,session_hash,visit_epoch,room_id,bot_id,revision,message_hash,fingerprint) VALUES(?,?,?,?,?,?,?,?,?)',b.actor_id,b.operation_id,b.session_hash,b.visit_epoch,b.room_id,b.bot_id,b.revision,b.message_hash,b.fingerprint);});
        const claim=storage.claim(identity(b));
        if(claim.status!=='new'){const prior=known(b,storage,{duplicate:true});send(res,prior.status==='pending'?202:200,prior);return true;}
        // claim() has committed before start can invoke the provider or any tool.
        start(b,config,message,storage);assertScope(b);send(res,202,envelope(b,'pending'));return true;
      }
      if((method==='GET'&&operationId&&!action)||(method==='POST'&&operationId&&action==='cancel')){
        if(action){const input=await body(req);exact(input,[]);}
        const{b,config}=currentBinding(req,userId,roomId,botId,operationId),storage=actorJournal(b,config);
        if(action){const entry=active.get(key(b));if(entry){entry.cancelRequested=true;entry.controller.abort();}}
        const result=known(b,storage);if(!result)v.fail(404,'RESIDENT_TURN_NOT_FOUND');assertScope(b);send(res,200,result);return true;
      }
      v.fail(405,'METHOD_NOT_ALLOWED');
    }catch(error){if(error.status)throw error;if(error.code?.startsWith('TURN_'))v.fail(error.code==='TURN_REUSED'?409:503,error.code,'The durable test receipt is unavailable');throw error;}
  }
  return Object.freeze({handle,catalog:()=>({available:!!adapter,mode:adapter?'local-loopback-test':'unavailable',toolMask:{...mask},limits:{...RESIDENT_LIMITS}}),
    sessionChanged(token){if(closed)return;autocommit(store);store.run('UPDATE main.resident_session_visits_v1 SET epoch=epoch+1 WHERE session_hash=?',token);for(const entry of active.values())if(entry.binding.session_hash===token)entry.controller.abort();},
    policyChanged(){for(const entry of active.values())try{assertScope(entry.binding);}catch{entry.controller.abort();}},
    botChanged(roomId,botId){for(const entry of active.values())if(entry.binding.room_id===roomId&&entry.binding.bot_id===botId)entry.controller.abort();},
    async close(){if(closed)return;closing=true;for(const entry of active.values())entry.controller.abort();await Promise.allSettled([...active.values()].map(entry=>entry.promise));journal.close();closed=true;rates.clear();}
  });
}
