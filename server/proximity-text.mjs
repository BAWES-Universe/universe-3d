import {createHash, randomUUID} from 'node:crypto';
import * as v from './validation.mjs';
import {createProximityTyping,PROXIMITY_TYPING} from './proximity-typing.mjs';

export const PROXIMITY_TEXT_LIMITS=Object.freeze({maxCodePoints:2000,maxBytes:8192,burst:5,refillPerSecond:1,history:200});
const PROTOCOL='proximity-text-v1',MAX_RECEIPTS=8192,MAX_EPOCH_RECEIPTS=128,MAX_RATES=4096,EPOCH_MS=120000;
const BODY_LIMIT=32768,BODY_TIMEOUT_MS=8000;
const KEYS=['requestId','text','connectionEpoch','roomId','bubbleId','memberId','membershipRevision'];
const opaque=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,200}$/.test(value);
export function validateProximityTextConfig(config,membershipConfig){
  if(!config||typeof config!=='object'||Array.isArray(config)||config.enabled!==true||Object.keys(config).length!==1||!membershipConfig)throw new Error('Proximity text requires explicit enabled:true and configured all-member proximity authority');
  return Object.freeze({enabled:true});
}
export async function readProximityTextBody(req){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))v.fail(415,'JSON_REQUIRED');
  const length=req.headers['content-length'];
  if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>BODY_LIMIT))v.fail(413,'PROXIMITY_TEXT_BODY_TOO_LARGE');
  const raw=await new Promise((resolve,reject)=>{
    const chunks=[];let size=0;
    const cleanup=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('aborted',abort);req.off('error',abort);};
    const fail=(status,code)=>{cleanup();req.resume();reject(new v.HttpError(status,code));};
    const data=chunk=>{size+=chunk.length;if(size>BODY_LIMIT)return fail(413,'PROXIMITY_TEXT_BODY_TOO_LARGE');chunks.push(chunk);};
    const end=()=>{cleanup();resolve(Buffer.concat(chunks).toString('utf8'));};
    const abort=()=>fail(400,'PROXIMITY_TEXT_BODY_ABORTED');
    const timer=setTimeout(()=>fail(408,'PROXIMITY_TEXT_BODY_TIMEOUT'),BODY_TIMEOUT_MS);timer.unref?.();
    req.on('data',data);req.on('end',end);req.on('aborted',abort);req.on('error',abort);
  });
  let value;try{value=JSON.parse(raw);}catch{v.fail(400,'INVALID_JSON');}return validateProximityTextRequest(value);
}
export function validateProximityTextRequest(value){
  v.record(value);
  if(Object.keys(value).length!==KEYS.length||KEYS.some(key=>!Object.hasOwn(value,key))||!opaque(value.connectionEpoch)||!opaque(value.bubbleId)||!opaque(value.memberId))v.fail(400,'INVALID_PROXIMITY_TEXT_REQUEST');
  v.id(value.roomId,'roomId');v.id(value.requestId,'requestId');v.integer(value.membershipRevision,'membershipRevision',1);
  if(typeof value.text!=='string')v.fail(400,'INVALID_PROXIMITY_TEXT');
  const text=value.text.replace(/\r\n?/g,'\n');
  if(!text.trim()||[...text].length>PROXIMITY_TEXT_LIMITS.maxCodePoints||Buffer.byteLength(text)>PROXIMITY_TEXT_LIMITS.maxBytes||!text.isWellFormed()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))v.fail(400,'INVALID_PROXIMITY_TEXT');
  return {...value,text};
}

/** Live forwarding only. Receipts store hashes/metadata, never text bodies.
 * Connections and authority are host-owned objects, never HTTP-selected peers.
 * An epoch is a particular SSE connection in one continuous room/bubble stay.
 */
export function createProximityText({store,media,connections,sse,now,typingTimers}){
  const receipts=new Map(),rates=new Map(),batches=new WeakSet();let closed=false,contextRevision=0,refreshRevision=0,requestOrder=0;
  const typing=createProximityTyping({store,connections,sse,now,timers:typingTimers,authority:{begin,capture,current,contextFor,order:()=>requestOrder}});
  const active=client=>!client.res.destroyed&&!client.res.writableEnded;
  const live=token=>store.get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?',token,now());
  function guarded(fn){try{if(closed)v.fail(503,'PROXIMITY_TEXT_UNAVAILABLE');return fn();}catch(error){if(error.status)throw error;v.fail(503,'PROXIMITY_TEXT_AUTHORITY_UNAVAILABLE');}finally{typing.flush();}}
  function rotate(client,key=null){typing.retireClient(client);client.proximityText={epoch:randomUUID(),key,startedAt:now(),count:0};}
  function retire(token){refreshRevision++;for(const client of connections.get(token)??[])rotate(client);prune();typing.flush();}
  function prune(){
    const epochs=new Set();for(const clients of connections.values())for(const client of clients)if(active(client)&&client.proximityText)epochs.add(client.proximityText.epoch);
    for(const[key,receipt]of receipts)if(!epochs.has(receipt.connectionEpoch)||now()-receipt.recordedAt>=EPOCH_MS)receipts.delete(key);
    for(const[key,rate]of rates)if(now()-rate.at>=5000)rates.delete(key);
  }
  function contextFor(s,client,refreshBatch){
    const p=s.current_room_id?(refreshBatch?refreshBatch.policyForSession(s):media.proximityTextPolicy(s)):null;
    const key=JSON.stringify([s.user_id,s.current_room_id,p?.memberId,p?.bubbleId,p?.context?.kind]);
    if(!client.proximityText||client.proximityText.key!==key||now()-client.proximityText.startedAt>=EPOCH_MS||client.proximityText.count>=MAX_EPOCH_RECEIPTS)rotate(client,key);
    const eligible=p?.context.kind==='proximity'&&!!p.bubbleId&&!!p.memberId&&p.conversationRecipients.length>0;
    const muted=eligible&&store.authorize(p.roomId,s.user_id).member?.muted_until>now();
    const value={protocol:PROTOCOL,typing:PROXIMITY_TYPING,contextRevision:++contextRevision,available:true,canSend:!!eligible&&!muted,reason:muted?'muted':eligible?null:'no-active-bubble',selfId:s.user_id,roomId:s.current_room_id,connectionEpoch:client.proximityText.epoch,bubbleId:p?.bubbleId??null,memberId:p?.memberId??null,membershipRevision:p?.membershipRevision??null,conversationRecipients:eligible?p.conversationRecipients:[],recipientCount:eligible?p.conversationRecipients.length:0,limits:PROXIMITY_TEXT_LIMITS};
    typing.observe(client,value);return value;
  }
  function findClient(s,epoch){const client=[...(connections.get(s.token_hash)??[])].find(c=>active(c)&&c.proximityText?.epoch===epoch);if(!client)v.fail(409,'STALE_PROXIMITY_TEXT_CONNECTION');return client;}
  function current(accepted){const s=live(accepted.token_hash);if(!s||s.user_id!==accepted.user_id||s.current_room_id!==accepted.current_room_id)v.fail(401,'AUTH_REQUIRED');return s;}
  function context(accepted,epoch){return guarded(()=>{const s=current(accepted),client=findClient(s,epoch),p=contextFor(s,client);sse(client.res,'proximity-text-context',p);typing.flush();return p;});}
  function push(token,client,refreshBatch,accepted,revision){
    const superseded=()=>revision!==undefined&&revision!==refreshRevision;
    let value;try{const s=accepted?current(accepted):live(token);if(!s||superseded())return;value=guarded(()=>contextFor(s,client,refreshBatch));}catch{if(superseded())return;rotate(client);value={protocol:PROTOCOL,typing:PROXIMITY_TYPING,contextRevision:++contextRevision,available:true,canSend:false,reason:'authority-unavailable',selfId:client.userId,connectionEpoch:client.proximityText.epoch,roomId:null,bubbleId:null,memberId:null,membershipRevision:null,conversationRecipients:[],recipientCount:0,limits:PROXIMITY_TEXT_LIMITS};}
    if(!superseded()&&active(client))sse(client.res,'proximity-text-context',value);
  }
  function refresh(roomId){
    typing.defer();try{
    const revision=++refreshRevision,rooms=new Map();
    for(const[token,clients]of connections){
      let s;try{s=live(token);}catch{continue;}if(!s||roomId&&s.current_room_id!==roomId)continue;
      const entries=rooms.get(s.current_room_id)??[];entries.push({token,session:s,clients:[...clients]});rooms.set(s.current_room_id,entries);
    }
    // A capture synchronizes all room members once. Each stream still rereads
    // its accepted session and ACL; batches never reach begin/send or GET.
    // Finish one room before capturing another: authority transactions are global.
    for(const[id,entries]of rooms){
      if(revision!==refreshRevision)break;
      let batch;try{if(id)batch=media.captureProximityTextRoom(id);}catch(error){batch={policyForSession(){throw error;}};}
      for(const{token,session,clients}of entries)for(const client of clients){
        // A nested refresh owns newer contexts. Do not overwrite them or include
        // streams added by a synchronous SSE callback in this older refresh.
        if(revision!==refreshRevision)break;
        if(connections.get(token)?.has(client)&&active(client))push(token,client,batch,session,revision);
      }
    }
    prune();
    }finally{typing.resume();}
  }
  function capture(accepted,b){
    const s=current(accepted),client=findClient(s,b.connectionEpoch),p=contextFor(s,client);
    if(!p.canSend)v.fail(403,p.reason==='muted'?'MUTED':'PROXIMITY_TEXT_FORBIDDEN');
    if(['connectionEpoch','roomId','bubbleId','memberId','membershipRevision'].some(key=>p[key]!==b[key])){sse(client.res,'proximity-text-context',p);v.fail(409,'STALE_PROXIMITY_TEXT_CONTEXT');}
    return {s,client,p};
  }
  function takeToken(accountId){
    const at=now();let bucket=rates.get(accountId);
    if(!bucket){if(rates.size>=MAX_RATES)v.fail(503,'PROXIMITY_TEXT_CAPACITY');bucket={at,tokens:5};rates.set(accountId,bucket);}
    bucket.tokens=Math.min(5,bucket.tokens+Math.max(0,at-bucket.at)/1000);bucket.at=at;
    if(bucket.tokens<1)v.fail(429,'PROXIMITY_TEXT_RATE_LIMITED');bucket.tokens--;
  }
  function matches(p,b,memberId){return p.roomId===b.roomId&&p.bubbleId===b.bubbleId&&p.memberId===memberId&&p.membershipRevision===b.membershipRevision;}
  function begin(accepted){return guarded(()=>{
    const s=current(accepted),p=media.proximityTextPolicy(s);
    if(p.context.kind!=='proximity'||!p.memberId||!p.bubbleId)v.fail(403,'PROXIMITY_TEXT_FORBIDDEN');
    const audience=new Map(p.conversationRecipients.map(peer=>[peer.accountId,peer.memberId]));audience.set(s.user_id,p.memberId);
    // Snapshot actual open connections. A later socket or sibling admission can
    // never inherit this event, even if the account remains in the same bubble.
    const targets=[];
    for(const[token,clients]of connections){
      const target=live(token);if(!target||!audience.has(target.user_id))continue;
      for(const other of clients){if(!active(other))continue;const q=contextFor(target,other);
        if(matches(q,p,audience.get(target.user_id)))targets.push({token,client:other,session:target,epoch:q.connectionEpoch,memberId:q.memberId,ownAccountCopy:target.user_id===s.user_id});
      }
    }
    const batch={order:++requestOrder,token:s.token_hash,sourceEpochs:new Set(targets.filter(target=>target.token===s.token_hash).map(target=>target.epoch)),roomId:p.roomId,bubbleId:p.bubbleId,memberId:p.memberId,membershipRevision:p.membershipRevision,targets};batches.add(batch);typing.flush();return batch;
  });}
  function send(accepted,input,batch){return guarded(()=>{
    if(!batches.has(batch))v.fail(409,'STALE_PROXIMITY_TEXT_REQUEST');batches.delete(batch);
    const b=validateProximityTextRequest(input),{s,client,p}=capture(accepted,b);prune();
    if(batch.token!==s.token_hash||!batch.sourceEpochs.has(b.connectionEpoch)||!matches(batch,b,b.memberId))v.fail(409,'STALE_PROXIMITY_TEXT_CONTEXT');
    const receiptKey=JSON.stringify([s.token_hash,b.requestId]),hash=createHash('sha256').update(JSON.stringify(b)).digest('hex');
    const prior=receipts.get(receiptKey);
    if(prior){if(prior.hash!==hash)v.fail(409,'PROXIMITY_TEXT_REQUEST_REUSED');return {message:{...prior.message,text:b.text},duplicate:true};}
    if(receipts.size>=MAX_RECEIPTS)v.fail(503,'PROXIMITY_TEXT_CAPACITY');
    const targets=batch.targets;
    // All authority reads above complete before the first body can be emitted.
    capture(accepted,b);const author=store.user(s.user_id);if(!author)v.fail(401,'AUTH_REQUIRED');
    takeToken(s.user_id);
    const meta={id:randomUUID(),requestId:b.requestId,createdAt:now(),roomId:b.roomId,bubbleId:b.bubbleId,membershipRevision:b.membershipRevision,fromMemberId:b.memberId,author:{id:author.id,name:author.name,appearance:author.appearance},recipient:{connectionEpoch:b.connectionEpoch,memberId:b.memberId},ownAccountCopy:false};
    // Insert before emitting: reentrant same-session retries cannot emit twice.
    receipts.set(receiptKey,{hash,message:meta,connectionEpoch:b.connectionEpoch,recordedAt:now()});client.proximityText.count++;typing.textAccepted(client,batch.order);
    for(const target of targets){
      if(target.client===client)continue;
      if(!connections.get(target.token)?.has(target.client)||!active(target.client)||target.client.proximityText?.epoch!==target.epoch)continue;
      try{
        // Revalidate sender and each recipient at the actual synchronous write.
        // No awaits, replay queue or delayed transport callbacks are permitted.
        const source=current(accepted),sourcePolicy=media.proximityTextPolicy(source);
        if(!matches(sourcePolicy,b,b.memberId)||store.authorize(b.roomId,s.user_id).member?.muted_until>now())break;
        const next=current(target.session),q=contextFor(next,target.client);
        if(q.connectionEpoch!==target.epoch||!matches(q,b,target.memberId))continue;
        if(next.user_id!==s.user_id&&!q.conversationRecipients.some(peer=>peer.accountId===s.user_id&&peer.memberId===b.memberId))continue;
        sse(target.client.res,'proximity-text-context',q);
        if(!active(target.client)||target.client.proximityText?.epoch!==target.epoch||!matches(media.proximityTextPolicy(current(target.session)),b,target.memberId)||!matches(media.proximityTextPolicy(current(accepted)),b,b.memberId)||store.authorize(b.roomId,s.user_id).member?.muted_until>now())continue;
        sse(target.client.res,'proximity-text-message',{...meta,text:b.text,recipient:{connectionEpoch:target.epoch,memberId:target.memberId},ownAccountCopy:target.ownAccountCopy});
      }catch(error){if(!error.status||error.status>=500)break;/* A revoked target is dropped; an authority failure stops this batch. */}
    }
    const result={message:{...meta,text:b.text},duplicate:false};
    return result;
  });}
  return {begin,context,send,retire,refresh,typing,disconnect(client){refreshRevision++;typing.retireClient(client);typing.flush();},register(token,client){refreshRevision++;rotate(client);push(token,client);typing.flush();},close(){refreshRevision++;typing.close();closed=true;receipts.clear();rates.clear();}};
}
