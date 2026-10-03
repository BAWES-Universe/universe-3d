import {randomUUID} from 'node:crypto';
import * as v from './validation.mjs';

export const PROXIMITY_TYPING=Object.freeze({protocol:'proximity-typing-v1',enabled:true,refreshMs:2000,idleMs:10000,expiryMs:12000});
export const PROXIMITY_TYPING_LIMITS=Object.freeze({bodyBytes:2048,bodyTimeoutMs:2000,burst:8,refillPerSecond:2,accountSources:64,sources:8192,recipientContributions:65536});
const KEYS=['connectionEpoch','roomId','bubbleId','memberId','membershipRevision','sequence','isTyping'];
const opaque=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,200}$/.test(value);
export function validateProximityTypingRequest(value){
  v.record(value);
  if(Object.keys(value).length!==KEYS.length||KEYS.some(key=>!Object.hasOwn(value,key))||!opaque(value.connectionEpoch)||!opaque(value.bubbleId)||!opaque(value.memberId)||!Number.isSafeInteger(value.sequence)||value.sequence<1||!Number.isSafeInteger(value.membershipRevision)||value.membershipRevision<1||typeof value.isTyping!=='boolean')v.fail(400,'INVALID_PROXIMITY_TYPING_REQUEST');
  v.id(value.roomId,'roomId');return value;
}
export async function readProximityTypingBody(req){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))v.fail(415,'JSON_REQUIRED');
  const length=req.headers['content-length'];
  if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>PROXIMITY_TYPING_LIMITS.bodyBytes))v.fail(413,'PROXIMITY_TYPING_BODY_TOO_LARGE');
  const raw=await new Promise((resolve,reject)=>{
    const chunks=[];let size=0;
    const cleanup=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('aborted',abort);req.off('error',abort);};
    const fail=(status,code)=>{cleanup();req.resume();reject(new v.HttpError(status,code));};
    const data=chunk=>{size+=chunk.length;if(size>PROXIMITY_TYPING_LIMITS.bodyBytes)return fail(413,'PROXIMITY_TYPING_BODY_TOO_LARGE');chunks.push(chunk);};
    const end=()=>{cleanup();resolve(Buffer.concat(chunks).toString('utf8'));};
    const abort=()=>fail(400,'PROXIMITY_TYPING_BODY_ABORTED');
    const timer=setTimeout(()=>fail(408,'PROXIMITY_TYPING_BODY_TIMEOUT'),PROXIMITY_TYPING_LIMITS.bodyTimeoutMs);timer.unref?.();
    req.on('data',data);req.on('end',end);req.on('aborted',abort);req.on('error',abort);
  });
  let value;try{value=JSON.parse(raw);}catch{v.fail(400,'INVALID_JSON');}return validateProximityTypingRequest(value);
}

/** Ephemeral metadata only. Snapshot/capture always use fresh authority. observe
 * is deliberately state-only: metadata refresh batches cannot perform a second
 * authority transaction until their host calls flush after completing the batch.
 */
export function createProximityTyping({store,connections,sse,now,authority,timers={setTimeout,clearTimeout}}){
  const states=new Map(),accounts=new Map(),rates=new Map(),pending=new Map(),batches=new WeakSet();
  let closed=false,eventRevision=0,contributions=0,flushing=false,deferDepth=0;
  const active=client=>!client.res.destroyed&&!client.res.writableEnded;
  const connected=(token,client,epoch)=>connections.get(token)?.has(client)&&active(client)&&client.proximityText?.epoch===epoch;
  // Room mute disables publication, not reception of ordinary Nearby metadata.
  const receiveEligible=p=>p.available===true&&!!p.roomId&&!!p.bubbleId&&!!p.memberId&&(p.reason===null||p.reason==='muted')&&p.conversationRecipients.length>0;
  const matches=(p,b,memberId)=>p.roomId===b.roomId&&p.bubbleId===b.bubbleId&&p.memberId===memberId&&p.membershipRevision===b.membershipRevision;
  function stateFor(s,client){
    let state=states.get(client);if(state)return state;
    if(states.size>=PROXIMITY_TYPING_LIMITS.sources||(accounts.get(s.user_id)??0)>=PROXIMITY_TYPING_LIMITS.accountSources)v.fail(503,'PROXIMITY_TYPING_CAPACITY');
    state={client,token:s.token_hash,accountId:s.user_id,epoch:client.proximityText.epoch,sourceId:randomUUID(),sequence:0,fence:0,lease:null};
    states.set(client,state);accounts.set(s.user_id,(accounts.get(s.user_id)??0)+1);return state;
  }
  function removeLease(state,fence=authority.order()){
    state.fence=Math.max(state.fence,fence);const lease=state.lease;if(!lease)return;
    state.lease=null;timers.clearTimeout(lease.timer);contributions-=lease.targets.size;
    // Capture the stop revision before a synchronous write can start newer work.
    pending.set(state.sourceId,{...lease,revision:++eventRevision});
  }
  function retireClient(client){
    const state=states.get(client);if(state){removeLease(state);states.delete(client);const n=accounts.get(state.accountId)-1;if(n)accounts.set(state.accountId,n);else accounts.delete(state.accountId);}
    // A removed recipient must never receive a delayed start or cleanup stop.
    for(const other of states.values())if(other.lease?.targets.delete(client))contributions--;
    for(const lease of pending.values())lease.targets.delete(client);
  }
  function observe(client,p){
    const state=states.get(client);
    if(state?.lease&&(!p.canSend||p.connectionEpoch!==state.epoch||!matches(p,state.lease.b,state.lease.b.memberId)))removeLease(state);
    for(const other of states.values()){
      const lease=other.lease,target=lease?.targets.get(client);
      if(target&&(!receiveEligible(p)||p.connectionEpoch!==target.epoch||!matches(p,lease.b,target.memberId))){lease.targets.delete(client);contributions--;}
    }
  }
  function targetPolicy(target,b){
    if(!connected(target.token,target.client,target.epoch))return null;
    const session=authority.current(target.session),p=authority.contextFor(session,target.client);
    if(!receiveEligible(p)||p.connectionEpoch!==target.epoch||!matches(p,b,target.memberId))return null;
    return p;
  }
  function sourcePolicy(lease){
    if(!connected(lease.state.token,lease.state.client,lease.state.epoch))return false;
    const {p}=authority.capture(lease.accepted,lease.b);
    return lease.state.lease===lease&&p.canSend&&now()<lease.expiresAt;
  }
  function envelope(lease,target,isTyping,revision=lease.revision){return {protocol:PROXIMITY_TYPING.protocol,roomId:lease.b.roomId,bubbleId:lease.b.bubbleId,membershipRevision:lease.b.membershipRevision,recipient:{connectionEpoch:target.epoch,memberId:target.memberId},author:lease.author,fromMemberId:lease.b.memberId,sourceId:lease.state.sourceId,revision,isTyping,serverTime:now(),expiresAt:isTyping?lease.expiresAt:now()};}
  function flush(){
    if(flushing||deferDepth)return;flushing=true;
    try{while(pending.size){const lease=pending.values().next().value;pending.delete(lease.state.sourceId);
      for(const target of lease.targets.values())try{
        // Cleanup is metadata about an already delivered contribution. Its source
        // may be gone; only the exact old recipient stay is freshly authorized.
        if(targetPolicy(target,lease.b)&&connected(target.token,target.client,target.epoch))sse(target.client.res,'proximity-typing',envelope(lease,target,false,lease.revision));
      }catch{/* Fail closed, including authority outages. Receiver lease still expires. */}
    }}finally{flushing=false;}
  }
  function schedule(lease){
    if(lease.state.lease!==lease||closed)return;
    const delay=Math.max(0,Math.min(1000,lease.expiresAt-now(),lease.accepted.expires_at-now()));
    lease.timer=timers.setTimeout(()=>{
      if(closed||lease.state.lease!==lease)return;
      try{
        if(now()>=lease.expiresAt||!sourcePolicy(lease))removeLease(lease.state);
        else for(const[client,target]of lease.targets)if(!targetPolicy(target,lease.b)){lease.targets.delete(client);contributions--;}
      }catch{removeLease(lease.state);}
      flush();schedule(lease);
    },delay);lease.timer?.unref?.();
  }
  function takeToken(accountId){
    const at=now();let bucket=rates.get(accountId);if(!bucket){for(const[id,rate]of rates)if(at-rate.at>=4000)rates.delete(id);if(rates.size>=PROXIMITY_TYPING_LIMITS.sources)v.fail(503,'PROXIMITY_TYPING_CAPACITY');bucket={at,tokens:PROXIMITY_TYPING_LIMITS.burst};rates.set(accountId,bucket);}
    bucket.tokens=Math.min(PROXIMITY_TYPING_LIMITS.burst,bucket.tokens+Math.max(0,at-bucket.at)*PROXIMITY_TYPING_LIMITS.refillPerSecond/1000);bucket.at=at;
    if(bucket.tokens<1)v.fail(429,'PROXIMITY_TYPING_RATE_LIMITED');bucket.tokens--;
  }
  function begin(accepted){if(closed)v.fail(503,'PROXIMITY_TYPING_UNAVAILABLE');const batch=authority.begin(accepted);batches.add(batch);return batch;}
  function update(accepted,input,batch){
    if(closed)v.fail(503,'PROXIMITY_TYPING_UNAVAILABLE');
    if(!batches.has(batch))v.fail(409,'STALE_PROXIMITY_TYPING_REQUEST');batches.delete(batch);
    let operationLease;
    try{
      const b=validateProximityTypingRequest(input),{s,client}=authority.capture(accepted,b);
      if(batch.token!==s.token_hash||!batch.sourceEpochs.has(b.connectionEpoch)||!matches(batch,b,b.memberId))v.fail(409,'STALE_PROXIMITY_TEXT_CONTEXT');
      const state=stateFor(s,client);
      if(state.lease&&now()>=state.lease.expiresAt)removeLease(state);
      if(b.sequence<=state.sequence)return {accepted:false};
      state.sequence=b.sequence;
      if(batch.order<=Math.max(state.fence,client.proximityText.typingFence??0))return {accepted:false};
      if(!b.isTyping){const existed=!!state.lease;removeLease(state,batch.order);return {accepted:existed};}
      if(state.lease&&now()-state.lease.startedAt<PROXIMITY_TYPING.refreshMs)return {accepted:false};
      const targets=batch.targets.filter(target=>target.session.user_id!==s.user_id);
      if(contributions-(state.lease?.targets.size??0)+targets.length>PROXIMITY_TYPING_LIMITS.recipientContributions)v.fail(503,'PROXIMITY_TYPING_CAPACITY');
      takeToken(s.user_id);const author=store.user(s.user_id);if(!author)v.fail(401,'AUTH_REQUIRED');
      if(state.lease){timers.clearTimeout(state.lease.timer);contributions-=state.lease.targets.size;}
      const lease={state,accepted:s,b,author:{id:author.id,name:author.name},order:batch.order,startedAt:now(),expiresAt:now()+PROXIMITY_TYPING.expiryMs,revision:++eventRevision,targets:new Map(),timer:null};state.lease=lease;operationLease=lease;
      for(const target of targets){
        if(!sourcePolicy(lease))break;
        const q=targetPolicy(target,b);if(!q||!q.conversationRecipients.some(peer=>peer.accountId===s.user_id&&peer.memberId===b.memberId))continue;
        sse(target.client.res,'proximity-text-context',q);
        // A context write can synchronously revoke a stream, replace an epoch or
        // start a newer operation. Recheck both sides immediately before emit.
        if(!targetPolicy(target,b)||!sourcePolicy(lease)||!connected(target.token,target.client,target.epoch))continue;
        lease.targets.set(target.client,target);contributions++;
        sse(target.client.res,'proximity-typing',envelope(lease,target,true));
      }
      if(state.lease===lease){if(!sourcePolicy(lease))removeLease(state);else schedule(lease);}
      return {accepted:state.lease===lease};
    }catch(error){
      if(operationLease&&operationLease.state.lease===operationLease)removeLease(operationLease.state);
      // Invalidate only a captured source on authority failure, never an epoch
      // selected from untrusted request fields after the failure.
      if(!error.status||error.status>=500)for(const target of batch.targets)if(target.token===batch.token&&batch.sourceEpochs.has(target.epoch)){const state=states.get(target.client);if(state?.epoch===target.epoch)removeLease(state);}
      if(error.status)throw error;v.fail(503,'PROXIMITY_TYPING_AUTHORITY_UNAVAILABLE');
    }finally{flush();}
  }
  function textAccepted(client,order){
    client.proximityText.typingFence=Math.max(client.proximityText.typingFence??0,order);
    const state=states.get(client);if(state?.lease&&state.lease.order<=order)removeLease(state,order);
    flush();
  }
  function close(){if(closed)return;for(const state of states.values())removeLease(state);flush();closed=true;states.clear();accounts.clear();rates.clear();}
  return {begin,update,observe,retireClient,flush,textAccepted,close,invalidateRoom(roomId){for(const state of states.values())if(state.lease?.b.roomId===roomId)removeLease(state);flush();},defer(){deferDepth++;},resume(){deferDepth--;flush();}};
}
