import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createGameServer} from '../server/app.mjs';
import {initializeResidentTurnStorage,createResidentTurnService} from '../server/resident-turns.mjs';
import {Store} from '../server/store.mjs';
import {createHostTurnJournal} from '../server/host-turn-journal.mjs';
import {runResidentTurn} from '../server/resident-turn-runner.mjs';
const scene={version:1,bounds:{width:24,depth:24},spawn:{x:0,z:0},objects:[],areas:[]};
const seeds=[{id:'w',name:'World',rooms:[{id:'room',name:'Room',scene},{id:'other',name:'Other',scene}]}];
const mask={pause:true,resume:true,return:true};
const chat=(text='Synthetic answer')=>({choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});
const tools=(calls=[{id:'call-one',type:'function',function:{name:'pause',arguments:'{}'}}])=>({choices:[{index:0,message:{role:'assistant',content:null,tool_calls:calls},finish_reason:'tool_calls'}]});
async function until(fn){for(let i=0;i<300;i++){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,5));}throw new Error('Condition did not become true');}
async function fixture(t,{reply,options,config={},enabled=true}={}){
 const dir=await mkdtemp(join(tmpdir(),'resident-http-'));let app,closed=false;const requests=[];
 const provider=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;requests.push(JSON.parse(raw));res.setHeader('content-type','application/json');if(reply)return reply(req,res,requests.length,app);res.setHeader('content-type','application/json');res.end(JSON.stringify(chat()));});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${provider.address().port}/v1/chat/completions`,database=join(dir,'host.db');
 const residentTurnOptions=(typeof options==='function'?options({endpoint}):options)??{initializeJournal:true,provider:{endpoint,model:'synthetic'},toolMask:mask};
 app=createGameServer({database,seeds,...(enabled?{residentTurnOptions}:{})});await app.listen(0);
 const f={dir,database,endpoint,requests,app};
 async function call(who,path,method='GET',data){const res=await fetch(`http://127.0.0.1:${f.app.server.address().port}`+path,{method,headers:{'content-type':'application/json',...(who?{cookie:who.cookie}:{})},body:data===undefined?undefined:JSON.stringify(data)});const dataOut=await res.json();return{status:res.status,data:dataOut,cookie:res.headers.get('set-cookie')?.split(';')[0]};}
 async function actor(name){const r=await call(null,'/api/session','POST',{name});return{...r.data.user,cookie:r.cookie};}
 const owner=await actor('Owner'),member=await actor('Member'),editor=await actor('Editor'),legacy=await actor('Legacy');
 app.store.run("INSERT INTO world_members(world_id,user_id,role,created_at) VALUES('w',?,'editor',0)",editor.id);
 app.store.run("INSERT INTO members(room_id,user_id,role,granted) VALUES('room',?,'editor',1)",legacy.id);
 for(const actor of[owner,member,editor,legacy])assert.equal((await call(actor,'/api/rooms/room/join','POST',{})).status,200);
 const made=await call(owner,'/api/rooms/room/bots','POST',{clientOperationId:'make-bot',config:{name:'Synthetic resident',privateInstructions:'MANAGER_ONLY_SENTINEL_926',...config}});assert.equal(made.status,201);
 const bot=made.data.bot,base=`/api/rooms/room/bots/${bot.id}/turns`;
 Object.assign(f,{owner,member,editor,legacy,bot,base,call,actor,post:(op='turn-one',extra={},who=owner)=>call(who,base,'POST',{clientOperationId:op,revision:0,message:'Say hello',...extra}),get:(op='turn-one',who=owner)=>call(who,base+'/'+op),settle:async(op='turn-one',who=owner)=>until(async()=>{const r=await call(who,base+'/'+op);return r.status!==200||r.data.status!=='pending'?r:null;})});
 t.after(async()=>{if(!closed)await f.app.close();provider.closeAllConnections();await new Promise(r=>provider.close(r));await rm(dir,{recursive:true,force:true});});
 f.close=async()=>{await f.app.close();closed=true;};f.reopen=async()=>{f.app=createGameServer({database,seeds,residentTurnOptions:{...residentTurnOptions,initializeJournal:false}});await f.app.listen(0);closed=false;};
 return f;
}

test('explicit initialization, file durability and trusted options are required; provider absent by default',async t=>{
 assert.throws(()=>createGameServer({seeds,residentTurnOptions:{initializeJournal:true,provider:{endpoint:'http://127.0.0.1:1/v1/chat/completions',model:'test'}}}),{code:'TURN_JOURNAL_INVALID_DATABASE'});
 const f=await fixture(t,{enabled:false});const catalog=await f.call(f.owner,'/api/rooms/room/bots');assert.equal(catalog.data.catalog.residentTest.available,false);assert.deepEqual(catalog.data.bots[0].modelPermissions,{pause:false,resume:false,return:false});
 assert.equal((await f.post()).status,503);assert.equal(f.requests.length,0);assert.equal(f.app.store.get("SELECT name FROM sqlite_schema WHERE name='resident_turn_journal_v1'"),undefined);
 const file=join(f.dir,'uninitialized.db');const store=new Store(file,seeds);t.after(()=>store.close());
 assert.throws(()=>createResidentTurnService({store,options:{provider:{endpoint:f.endpoint,model:'test'}}}),{code:'RESIDENT_STORAGE_NOT_INITIALIZED'});
 store.db.exec('PRAGMA synchronous=NORMAL');assert.throws(()=>initializeResidentTurnStorage({store}),{code:'TURN_JOURNAL_DURABILITY_UNAVAILABLE'});assert.equal(store.get('PRAGMA synchronous').synchronous,1);
});

test('private manager HTTP turn is durably claimed before provider, completed once, replayed without generation',async t=>{
 let observedPending=false;const f=await fixture(t,{reply(req,res,n,app){const db=new DatabaseSync(app.store.db.location('main'),{readOnly:true});try{observedPending=db.prepare("SELECT state FROM resident_turn_journal_v1").get()?.state==='pending';}finally{db.close();}res.end(JSON.stringify(chat()));}});
 assert.equal((await f.post()).status,202);const done=await f.settle();assert.equal(done.data.status,'completed');assert.equal(done.data.result.text,'Synthetic answer');assert.equal(observedPending,true);
 const again=await f.post();assert.equal(again.status,200);assert.equal(again.data.duplicate,true);assert.deepEqual(again.data.result,done.data.result);assert.equal(f.requests.length,1);
 assert.equal((await f.post('turn-one',{message:'Different'})).data.code,'OPERATION_REUSED');
 assert.equal(f.app.store.get('SELECT COUNT(*) n FROM messages').n,0);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM bot_operations').n,1);
 assert.equal(JSON.stringify(done.data).includes('MANAGER_ONLY'),false);assert.equal(f.requests[0].tools,undefined);
 const room=await f.call(f.member,'/api/rooms/room');assert.equal(JSON.stringify(room.data).includes('MANAGER_ONLY'),false);assert.equal(JSON.stringify(room.data).includes('modelPermissions'),false);
});

test('manager means universe owner/world admin/editor only; wrong actor/session/room cannot read receipts',async t=>{
 const f=await fixture(t);for(const actor of[f.member,f.legacy])assert.equal((await f.post('forbidden',{},actor)).status,403);
 assert.equal((await f.post('editor',{},f.editor)).status,202);assert.equal((await f.settle('editor',f.editor)).data.status,'completed');assert.equal((await f.get('editor',f.owner)).status,404);
 const token='a'.repeat(43);const {createHash}=await import('node:crypto');f.app.store.run('INSERT INTO sessions(token_hash,user_id,expires_at,current_room_id) VALUES(?,?,?,?)',createHash('sha256').update(token).digest('hex'),f.editor.id,Date.now()+100000,'room');
 assert.equal((await f.get('editor',{cookie:'universe_session='+token})).data.code,'RESIDENT_SESSION_MISMATCH');
 assert.equal((await f.call(f.editor,f.base.replace('/room/','/other/')+'/editor')).status,403);
 assert.equal((await f.call(null,f.base)).status,401);
});

test('exact body, input/revision/config gates and forbidden provider fields do not call provider',async t=>{
 const f=await fixture(t);for(const extra of[{actorId:f.owner.id},{endpoint:f.endpoint},{permissions:mask},{roomId:'room'},{message:'x'.repeat(2001)},{revision:99},{message:''}])assert.ok((await f.post('bad-'+Object.keys(extra)[0],extra)).status>=400);
 assert.equal((await f.call(f.owner,f.base,'POST',{clientOperationId:'missing',message:'hi'})).status,400);
 assert.equal(f.requests.length,0);
 await f.call(f.owner,`/api/rooms/room/bots/${f.bot.id}`,'PATCH',{clientOperationId:'disable-replies',revision:0,patch:{respondToPlayers:false}});
 assert.equal((await f.post('disabled',{revision:1})).data.code,'BOT_RESPONSE_DISABLED');
 assert.equal((await f.call(f.owner,f.base+'/unknown/cancel','POST',{retry:true})).status,400);
});

test('separate model permission AND manual permission AND factory mask; allowed command receipt is acceptance only',async t=>{
 const f=await fixture(t,{config:{modelPermissions:mask},reply(req,res,n){res.end(JSON.stringify(n===1?tools():chat('The command was accepted.')));}});
 await f.post();const done=await f.settle();assert.equal(done.data.status,'completed');assert.equal(done.data.result.toolResults[0].status,'accepted');assert.equal(done.data.result.toolResults[0].name,'pause');
 assert.equal(f.requests.length,2);assert.equal(f.requests[1].messages.at(-1).role,'tool');assert.match(f.requests[1].messages.at(-1).content,/command-accepted-not-arrived/);
 const command=done.data.result.toolResults[0].operationId;assert.equal(f.app.store.get('SELECT COUNT(*) n FROM bot_operations WHERE operation_id=?',command).n,1);
 await f.post();assert.equal(f.requests.length,2);
 const masked=await fixture(t,{config:{modelPermissions:mask,permissions:{...mask,pause:false}},reply(req,res){res.end(JSON.stringify(tools()));}});await masked.post();const blocked=await masked.settle();assert.equal(blocked.data.status,'error');assert.equal(blocked.data.result.code,'RESIDENT_PROVIDER_RESPONSE');assert.equal(masked.requests.length,1);assert.equal(masked.app.store.get('SELECT COUNT(*) n FROM bot_operations').n,1);
 const defaults=await fixture(t,{reply(req,res){res.end(JSON.stringify(tools()));}});await defaults.post();assert.equal((await defaults.settle()).data.status,'error');assert.equal(defaults.requests[0].tools,undefined);
});

test('move and malformed tool args are rejected without command effects or second provider call',async t=>{
 for(const [name,args]of[['move','{}'],['pause','{"x":1}'],['pause','not json']]){const f=await fixture(t,{config:{modelPermissions:mask},reply(req,res){res.end(JSON.stringify(tools([{id:'call-one',type:'function',function:{name,arguments:args}}])));}});await f.post();const done=await f.settle();assert.ok(['error','limited'].includes(done.data.status));if(done.data.result.toolResults.length)assert.equal(done.data.result.toolResults[0].status,'rejected');assert.equal(f.requests.length,1);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM bot_operations').n,1);}
});

test('provider failure, private instruction echo and unsafe output are truthful terminal failures with no canned reply',async t=>{
 for(const value of[null,'MANAGER_ONLY_SENTINEL_926','<script>bad</script>']){const f=await fixture(t,{reply(req,res){if(value===null){res.statusCode=500;res.end('{"error":"PRIVATE_PROVIDER_DETAIL"}');}else res.end(JSON.stringify(chat(value)));}});await f.post();const done=await f.settle();assert.ok(['error','filtered'].includes(done.data.status));assert.equal(done.data.result.text,'');assert.equal(JSON.stringify(done.data).includes('PRIVATE_PROVIDER_DETAIL'),false);await f.post();assert.equal(f.requests.length,1);}
});

test('cancel acknowledgement is private and terminal cancellation is persisted, never retried',async t=>{
 const f=await fixture(t,{reply(){}});await f.post();await until(()=>f.requests.length===1);
 const pending=await f.get();assert.equal(pending.data.status,'pending');assert.equal((await f.post('another')).data.code,'RESIDENT_CONCURRENCY_LIMIT');
 const cancel=await f.call(f.owner,f.base+'/turn-one/cancel','POST',{});assert.equal(cancel.data.cancelRequested,true);assert.equal((await f.settle()).data.status,'cancelled');
 const replay=await f.post();assert.equal(replay.data.status,'cancelled');assert.equal(f.requests.length,1);
});

test('leave/rejoin, configuration change, role revocation and archive abort and suppress late provider output',async t=>{
 for(const mode of['leave','edit','revoke','archive']){
  let held;const f=await fixture(t,{reply(req,res){held=res;}});const actor=mode==='revoke'?f.editor:f.owner;
  await f.post('late',{},actor);await until(()=>held);
  if(mode==='leave'){await f.call(actor,'/api/rooms/room/leave','POST',{});await f.call(actor,'/api/rooms/room/join','POST',{});}
  if(mode==='edit')await f.call(actor,`/api/rooms/room/bots/${f.bot.id}`,'PATCH',{clientOperationId:'edit-pending',revision:0,patch:{name:'Edited'}});
  if(mode==='revoke'){f.app.store.run("DELETE FROM world_members WHERE world_id='w' AND user_id=?",actor.id);}
  if(mode==='archive')f.app.store.run("UPDATE rooms SET archived_at=1 WHERE id='room'");
  held.end(JSON.stringify(chat('LATE_PRIVATE_SENTINEL')));const response=await f.settle('late',actor);assert.ok(response.status>=400);assert.equal(JSON.stringify(response.data).includes('LATE_PRIVATE'),false);
  assert.equal(f.app.store.get('SELECT state FROM resident_turn_journal_v1').state,'pending');assert.equal(f.requests.length,1);
 }
});

test('durability retune and outer transactions prevent acceptance and never call provider',async t=>{
 const f=await fixture(t);for(const begin of['BEGIN','SAVEPOINT outer_scope']){f.app.store.db.exec(begin);const r=await f.post();assert.equal(r.data.code,'TURN_JOURNAL_OUTER_TRANSACTION');assert.equal(f.app.store.db.isTransaction,true);f.app.store.db.exec('ROLLBACK');}
 f.app.store.db.exec('PRAGMA synchronous=NORMAL');const result=await f.post();assert.equal(result.data.code,'TURN_JOURNAL_DURABILITY_UNAVAILABLE');assert.equal(f.requests.length,0);assert.equal(f.app.store.get('PRAGMA synchronous').synchronous,1);
});

test('completed and orphaned pending receipts survive restart without regeneration',async t=>{
 const f=await fixture(t);await f.post();const done=await f.settle();const b=f.app.store.get('SELECT * FROM resident_turn_bindings_v1');
 const orphan={...b,operation_id:'orphan',fingerprint:'1'.repeat(64)};
 f.app.store.run('INSERT INTO resident_turn_bindings_v1 VALUES(?,?,?,?,?,?,?,?,?)',orphan.actor_id,orphan.operation_id,orphan.session_hash,orphan.visit_epoch,orphan.room_id,orphan.bot_id,orphan.revision,orphan.message_hash,orphan.fingerprint);
 const journal=createHostTurnJournal({database:f.app.store.db}),actor=journal.forActor({actorId:b.actor_id,authorize:()=>true});assert.equal(actor.claim({actorId:b.actor_id,turnId:'orphan',fingerprint:orphan.fingerprint}).status,'new');journal.close();
 await f.close();await f.reopen();assert.deepEqual((await f.get()).data.result,done.data.result);assert.equal((await f.get('orphan')).data.status,'uncertain');assert.equal((await f.get('orphan')).data.result.code,'TURN_OUTCOME_UNKNOWN');assert.equal(f.requests.length,1);
 const cancel=await f.call(f.owner,f.base+'/orphan/cancel','POST',{});assert.equal(cancel.data.status,'uncertain');assert.equal(cancel.data.cancelRequested,false);
});

test('runner stops at tool/call budget, unknown effect and changed authority, and never retries failures',async()=>{
 let calls=0,effects=0;const adapter={async complete(){calls++;return{text:null,toolCalls:[{id:'call-'+calls,name:'pause',arguments:'{}'}],finishReason:'tool_calls',usage:null};}};
 const base={adapter,actorId:'actor',operationId:'op',message:'hi',instructions:'',toolMask:mask,signal:new AbortController().signal,authorize(){},executeCommand(){effects++;return{accepted:true};}};
 let result=await runResidentTurn(base);assert.equal(result.status,'limited');assert.equal(calls,3);assert.equal(effects,3);
 calls=effects=0;result=await runResidentTurn({...base,executeCommand(){effects++;throw new Error('host unknown');}});assert.equal(result.status,'uncertain');assert.equal(calls,1);assert.equal(effects,1);assert.equal(result.toolResults[0].code,'MOVEMENT_OUTCOME_UNKNOWN');
 calls=effects=0;result=await runResidentTurn({...base,authorize(){throw Object.assign(new Error('no'),{status:403});}});assert.equal(result.status,'revoked');assert.equal(calls,0);assert.equal(effects,0);
});

test('rate and context limits are checked before durable acceptance; visits are created only when testing',async t=>{
 const f=await fixture(t);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM resident_session_visits_v1').n,0);
 for(let i=0;i<6;i++){assert.equal((await f.post('rate-'+i)).status,202);assert.equal((await f.settle('rate-'+i)).data.status,'completed');}
 assert.equal((await f.post('rate-over')).data.code,'RESIDENT_RATE_LIMIT');assert.equal(f.requests.length,6);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM resident_turn_journal_v1').n,6);
 assert.equal(f.app.store.get('SELECT COUNT(*) n FROM resident_session_visits_v1').n,1);
 const wide=await fixture(t,{config:{privateInstructions:'界'.repeat(4000)}});assert.equal((await wide.post()).data.code,'RESIDENT_CONTEXT_LIMIT');assert.equal(wide.requests.length,0);assert.equal(wide.app.store.get('SELECT COUNT(*) n FROM resident_turn_journal_v1').n,0);
});

test('completed response loss retries the same operation; model text and private config never enter room SSE',async t=>{
 const f=await fixture(t),controller=new AbortController();const stream=await fetch(`http://127.0.0.1:${f.app.server.address().port}/api/events`,{headers:{cookie:f.member.cookie},signal:controller.signal});
 let events='';const reading=(async()=>{try{for await(const data of stream.body)events+=Buffer.from(data).toString('utf8');}catch{}})();
 // Discard POST response exactly as a client with a lost HTTP response would.
 await f.post('lost-response');const saved=await f.settle('lost-response');assert.equal(saved.data.status,'completed');
 const retry=await f.post('lost-response');assert.deepEqual(retry.data.result,saved.data.result);assert.equal(f.requests.length,1);
 await f.call(f.member,'/api/presence','POST',{roomId:'room',x:0,z:0});await until(()=>events.includes('event: presence'));
 controller.abort();await reading;assert.ok(events.includes('event: hello'));
 for(const forbidden of['Synthetic answer','MANAGER_ONLY','privateInstructions','modelPermissions','event: message','event: quest'])assert.equal(events.includes(forbidden),false,forbidden);
});

test('accepted commands use the existing durable host receipt path and cannot credit quests',async t=>{
 const f=await fixture(t,{config:{modelPermissions:mask},reply(req,res,n,app){if(n===1)res.end(JSON.stringify(tools([{id:'return-home',type:'function',function:{name:'return',arguments:'{}'}}])));else{const command=app.store.get("SELECT result FROM bot_operations WHERE operation_id LIKE 'botai-%'");assert.equal(JSON.parse(command.result).accepted,true);res.end(JSON.stringify(chat('Request accepted.')));}}});
 const prior=f.app.store.all("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'quest%'").map(({name})=>[name,f.app.store.all(`SELECT * FROM ${name}`)]);
 await f.post();const done=await f.settle();assert.equal(done.data.result.toolResults[0].name,'return');assert.equal(done.data.result.toolResults[0].status,'accepted');
 const after=prior.map(([name])=>[name,f.app.store.all(`SELECT * FROM ${name}`)]);assert.deepEqual(after,prior);
});

test('filtered post-tool text preserves accepted effect receipts, and unconfirmed command returns stay uncertain',async()=>{
 let calls=0,effects=0;const base={actorId:'actor',operationId:'op',message:'hello',instructions:'secret manager instructions',toolMask:mask,signal:new AbortController().signal,authorize(){},executeCommand(){effects++;return{accepted:true};},adapter:{async complete(){return ++calls===1?{text:null,toolCalls:[{id:'c1',name:'pause',arguments:'{}'}],finishReason:'tool_calls',usage:null}:{text:'<script>unsafe</script>',toolCalls:[],finishReason:'stop',usage:null};}}};
 const result=await runResidentTurn(base);assert.equal(result.status,'filtered');assert.equal(effects,1);assert.equal(result.toolResults[0].status,'accepted');assert.equal(result.text,'');
 calls=effects=0;const unknown=await runResidentTurn({...base,executeCommand(){effects++;return{accepted:false};}});assert.equal(unknown.status,'uncertain');assert.equal(calls,1);assert.equal(effects,1);
 calls=effects=0;const unsafeCall=await runResidentTurn({...base,instructions:'c1'});assert.equal(effects,0);assert.equal(unsafeCall.status,'filtered');
});

test('unpersistable fixed receipt marker overlap rejects before provider or acceptance',async t=>{
 const f=await fixture(t,{config:{privateInstructions:'untrusted-provider-output'}});
 assert.equal((await f.post()).data.code,'RESIDENT_CONTEXT_UNREPRESENTABLE');assert.equal(f.requests.length,0);assert.equal(f.app.store.get('SELECT COUNT(*) n FROM resident_turn_journal_v1').n,0);
});

test('real HTTP process SIGKILL after provider dispatch preserves uncertain outcome and same-body retry never redispatches',async t=>{
 const {fork}=await import('node:child_process'),{once}=await import('node:events');
 const dir=await mkdtemp(join(tmpdir(),'resident-crash-')),database=join(dir,'host.db');let calls=0;
 const provider=http.createServer(async(req,res)=>{for await(const _ of req){}calls++;});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 const endpoint=`http://127.0.0.1:${provider.address().port}/v1/chat/completions`;
 const child=fork(new URL('./fixtures/resident-crash-host.mjs',import.meta.url),[],{stdio:['ignore','pipe','pipe','ipc']});let errors='';child.stderr.on('data',data=>errors+=data);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');provider.closeAllConnections();await new Promise(r=>provider.close(r));await rm(dir,{recursive:true,force:true});});
 const ready=once(child,'message');child.send({database,endpoint,seeds});const [message]=await ready;assert.ok(message.port,errors);let base=`http://127.0.0.1:${message.port}`,cookie;
 async function request(path,method='GET',body){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});cookie=r.headers.get('set-cookie')?.split(';')[0]??cookie;return{status:r.status,data:await r.json()};}
 await request('/api/session','POST',{name:'Crash owner'});await request('/api/rooms/room/join','POST',{});const bot=(await request('/api/rooms/room/bots','POST',{clientOperationId:'create',config:{name:'Crash test'}})).data.bot;
 const path=`/api/rooms/room/bots/${bot.id}/turns`,body={clientOperationId:'crash-turn',revision:0,message:'Synthetic crash test'};assert.equal((await request(path,'POST',body)).status,202);await until(()=>calls===1);
 const exit=once(child,'exit');child.kill('SIGKILL');await exit;
 const reopened=createGameServer({database,seeds,residentTurnOptions:{provider:{endpoint,model:'synthetic-crash'}}});await reopened.listen(0);t.after(()=>reopened.close());base=`http://127.0.0.1:${reopened.server.address().port}`;
 const receipt=await request(path+'/crash-turn');assert.equal(receipt.data.status,'uncertain');assert.equal(receipt.data.result.code,'TURN_OUTCOME_UNKNOWN');
 const retry=await request(path,'POST',body);assert.equal(retry.status,200);assert.equal(retry.data.status,'uncertain');assert.equal(retry.data.duplicate,true);assert.equal(calls,1);
});

test('factory tool mask defaults off even when saved manager model permission is on',async t=>{
 const f=await fixture(t,{config:{modelPermissions:mask},options:({endpoint})=>({initializeJournal:true,provider:{endpoint,model:'synthetic'}})});
 const catalog=await f.call(f.owner,'/api/rooms/room/bots');assert.deepEqual(catalog.data.catalog.residentTest.toolMask,{pause:false,resume:false,return:false});await f.post();assert.equal((await f.settle()).data.status,'completed');assert.equal(f.requests[0].tools,undefined);
});

test('global concurrency is bounded across managers and close durably cancels pending work',async t=>{
 const f=await fixture(t,{reply(){}}),managers=[f.owner,f.editor];
 for(let i=0;i<3;i++){const actor=await f.actor('Extra manager '+i);f.app.store.run("INSERT INTO world_members(world_id,user_id,role,created_at) VALUES('w',?,'editor',0)",actor.id);await f.call(actor,'/api/rooms/room/join','POST',{});managers.push(actor);}
 for(let i=0;i<4;i++)assert.equal((await f.post('manager-'+i,{},managers[i])).status,202);await until(()=>f.requests.length===4);
 assert.equal((await f.post('global-over',{},managers[4])).data.code,'RESIDENT_CONCURRENCY_LIMIT');assert.equal(f.requests.length,4);
 await f.close();await f.reopen();for(let i=0;i<4;i++)assert.equal((await f.get('manager-'+i,managers[i])).data.status,'cancelled');assert.equal(f.requests.length,4);
});

test('unsafe rejected tool IDs never leak or make an otherwise safe final receipt unpersistable',async t=>{
 const f=await fixture(t,{config:{modelPermissions:mask},reply(req,res){res.end(JSON.stringify(tools([{id:'MANAGER_ONLY_SENTINEL_926',type:'function',function:{name:'pause',arguments:'{"unexpected":1}'}}])));}});
 await f.post();const done=await f.settle();assert.equal(done.data.status,'filtered');assert.equal(done.data.result.text,'');assert.deepEqual(done.data.result.toolResults,[]);assert.equal(JSON.stringify(done.data).includes('MANAGER_ONLY_SENTINEL_926'),false);assert.equal(f.app.store.get('SELECT state FROM resident_turn_journal_v1').state,'terminal');assert.equal(f.app.store.get('SELECT COUNT(*) n FROM bot_operations').n,1);assert.equal(f.requests.length,1);
});
