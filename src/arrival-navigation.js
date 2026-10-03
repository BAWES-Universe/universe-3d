import {createArrivalState} from './arrival-state.js';
import {validateDestination,destinationKey} from './travel-location.js';

/** Initial plain links may observe a sibling's existing placement. Explicit
 * navigation still defaults to travel; only reloads of this session resume. */
export function initialArrivalMode({roomId,entry,invite},currentRoomId){
 if(!invite&&currentRoomId===roomId)return 'resume';
 return entry===undefined&&!invite?'enter':'travel';
}

const roomEvents=new Set(['presence','scene','room','role','members','bots','image-assets','access-revoked','moderation','media-policy']);
const identity=arrival=>arrival&&typeof arrival.admissionId==='string'&&typeof arrival.admissionEpoch==='string'&&Number.isSafeInteger(arrival.admissionRevision)&&arrival.admissionRevision>0?{admissionId:arrival.admissionId,admissionEpoch:arrival.admissionEpoch,admissionRevision:arrival.admissionRevision}:null;
const errorCode=error=>error?.data?.error?.code??error?.data?.error??error?.code;
const revoked=(event,accountId)=>event.type==='access-revoked'||event.type==='moderation'&&['kick','ban','deleted'].includes(event.data.action)&&(event.data.userId===accountId||event.data.action==='deleted');

/** Bounded target events, captured before a held admission response can render.
 * Revision orders scene snapshots; receipt order is used only for live policy.
 */
export function createArrivalEventBuffer(roomId,accountId){
 const events=new Map();let denied=null;
 return{
  observe(event){
   if(!roomEvents.has(event.type)||(event.data.roomId??event.data.room?.id)!==roomId)return false;
   if(revoked(event,accountId))denied=event;
   const previous=events.get(event.type),revision=event.data.room?.revision;
   if(previous&&Number.isSafeInteger(revision)&&Number.isSafeInteger(previous.data.room?.revision)&&revision<previous.data.room.revision)return true;
   events.set(event.type,event);return true;
  },
  snapshot(){return {denied,events:[...events.values()]};},
  merge(result){
   let room={...result.room};
   for(const event of events.values()){
    const next=event.data.room;
    if(next?.id===roomId&&(!Number.isSafeInteger(room.revision)||!Number.isSafeInteger(next.revision)||next.revision>=room.revision))room={...room,...next};
   }
   const role=events.get('role');if(role){room={...room,role:role.data.role??room.role,capabilities:role.data.capabilities??role.data.room?.capabilities??room.capabilities};}
   return {...result,room,presence:events.get('presence')?.data.presence??result.presence,members:events.get('members')?.data.members??result.members,bots:events.get('bots')?.data.bots??result.bots};
  }
 };
}

/** Serial authoritative admission. All side effects belong to the supplied shell
 * callbacks; no clocks, DOM, renderer, or mutable production test controls.
 */
export function createArrivalNavigation({api,getContext,beforeStart=async()=>true,onBegin=()=>{},onCommit=()=>{},onRetained=()=>{},onDecision=()=>{},onAuthorityLost=()=>{},onSettled=()=>{},onError=()=>{}}){
 const arrivals=createArrivalState();let queue=Promise.resolve(),sequence=0,sourceGeneration=0,active=null,lastIntent=null;
 const context=()=>({...getContext(),sourceGeneration});
 function sameContext(captured){const current=context();return current.accountId===captured.accountId&&current.sourceGeneration===captured.sourceGeneration;}
 function reset(){sourceGeneration++;sequence++;lastIntent=null;const value=context();arrivals.reset({accountId:value.accountId,roomId:value.roomId,sourceGeneration});return sourceGeneration;}
 function invalidateAuthority(reason){onAuthorityLost(reason);const value=context();arrivals.reset({accountId:value.accountId,roomId:value.roomId,sourceGeneration});}
 function apply(decision){if(decision.kind==='adopt'||decision.kind==='retain')onDecision(decision);return decision;}
 function hello(arrivalEpoch,generation=sourceGeneration){const decision=arrivals.hello({arrivalEpoch,sourceGeneration:generation});if(decision.kind==='refresh-required')onAuthorityLost(decision.reason);return decision;}
 function observe(event,generation=sourceGeneration){
  if(generation!==sourceGeneration)return {buffered:true,decision:{kind:'ignore',reason:'stale-source'}};
  let decision=null;
  if(event.type==='presence'){
   const person=event.data.presence?.find(person=>(person.id??person.userId)===getContext().accountId);
   if(person&&(person.id===undefined||person.id===getContext().accountId)&&(person.userId===undefined||person.userId===getContext().accountId)&&event.data.roomId!==active?.targetRoomId&&(event.data.roomId!==getContext().roomId||active?.sawTargetSelf)){
    // A stream is server-scoped to its session's current room. Unexpected
    // self-room evidence is a reconciliation hint, never a direct room grant.
    if(active)active.contextChanged=true;else{invalidateAuthority('session-room-changed');decision={kind:'refresh-required',reason:'session-room-changed'};}
   }
   if(person&&event.data.roomId===active?.targetRoomId)active.sawTargetSelf=true;
   if(person&&!decision)decision=arrivals.observeSelf({sourceGeneration:generation,roomId:event.data.roomId,presence:person});
   if(decision?.kind==='refresh-required')onAuthorityLost(decision.reason);else if(decision)apply(decision);
  }
  return {buffered:active?.buffer?.observe(event)??false,decision};
 }
 async function cleanup(roomId,arrival,captured){
  const expected=identity(arrival);if(!expected||!sameContext(captured))return false;
  try{const result=await api('/api/rooms/'+encodeURIComponent(roomId)+'/leave',{method:'POST',body:expected,deferRoomPreparation:true});return result.applied===true;}catch{return false;}
 }
 function navigate(roomId,options={}){
  const destination=validateDestination({roomId,...(options.entry===undefined?{}:{entry:options.entry})});
  const key=JSON.stringify([destinationKey(destination),options.mode??'travel',!!options.reconcile,options.sourceAction??null,options.invite??null]);
  if(lastIntent?.key===key)return lastIntent.promise;
  const intent=++sequence,captured=context();
  const current=()=>intent===sequence&&sameContext(captured);
  const run=async()=>{
   if(!current())return false;
   let allowed;try{allowed=await beforeStart(destination,options);}catch(error){if(current()){await onSettled({committed:false,failed:true,current:true,pending:false,options});onError(error);}throw error;}
   if(!current())return false;
   if(!allowed){await onSettled({committed:false,failed:false,current:true,pending:false,options});return false;}
   const operation={buffer:null,committed:null,ticket:null};active=operation;onBegin(destination,options);
   let committed=false,failed=false;
   const request=async(target,requestOptions)=>{
    operation.targetRoomId=target;operation.contextChanged=false;operation.sawTargetSelf=false;operation.buffer=createArrivalEventBuffer(target,captured.accountId);
    operation.ticket=arrivals.beginJoin({roomId:target});
    const body=['resume','enter'].includes(requestOptions.mode)?{mode:requestOptions.mode}:{mode:'travel',...(requestOptions.entry===undefined?{}:{entry:requestOptions.entry}),...(requestOptions.sourceAction?{sourceAction:requestOptions.sourceAction}:{})};
    const result=await api(requestOptions.invite?'/api/invites/'+encodeURIComponent(requestOptions.invite)+'/join':'/api/rooms/'+encodeURIComponent(target)+'/join',{method:'POST',body:requestOptions.invite?{}:body,deferRoomPreparation:true});
    operation.committed={roomId:result.room?.id,arrival:result.arrival};
    if(!current())return {stale:true,result};
    if(operation.contextChanged)return {refresh:true,result};
    if(operation.buffer.snapshot().denied){const error=Error('Your access to the destination changed while travelling.');error.code='DESTINATION_REVOKED';throw error;}
    const decision=arrivals.resolveJoin(operation.ticket,{roomId:result.room?.id,arrival:result.arrival});
    if(!['adopt','retain'].includes(decision.kind))return {refresh:true,decision,result};
    // No await between deciding placement and assigning pose + identity in main.
    onCommit({result:operation.buffer.merge(result),decision,destination:{roomId:target,...(requestOptions.entry===undefined?{}:{entry:requestOptions.entry})},options,events:operation.buffer.snapshot().events});
    committed=true;return {result,decision};
   };
   const reconcile=async()=>{
    if(!options.reconcile)onAuthorityLost('reconciling');
    for(let attempt=0;attempt<3&&current();attempt++){
     const session=await api('/api/session',{deferRoomPreparation:true});
     if(!current())return false;
     if(session.user?.id!==captured.accountId){invalidateAuthority('account-changed');return false;}
     if(!session.currentRoomId){invalidateAuthority('no-current-room');return false;}
     if(session.currentRoomId!==captured.roomId)onAuthorityLost('room-context-changed');
     try{
      const outcome=await request(session.currentRoomId,{mode:'resume'});
      if(outcome.stale)return false;
      if(!outcome.refresh)return true;
     }catch(error){
      if(errorCode(error)==='RESUME_CONTEXT_CHANGED')continue;
      throw error;
     }
    }
    if(current())invalidateAuthority('room-context-changing');return false;
   };
   try{
    const outcome=options.reconcile?{reconciled:await reconcile()}:await request(roomId,options);
    if(outcome.stale){if(sameContext(captured)){invalidateAuthority('superseded-admission');await cleanup(outcome.result.room?.id,outcome.result.arrival,captured);}return false;}
    if(outcome.refresh)return await reconcile();
    return options.reconcile?outcome.reconciled:true;
   }catch(error){
    failed=true;
    if(!sameContext(captured))return false;
    const known=operation.committed;
    if(error.status===401){
     invalidateAuthority('authentication-required');
    }else if(known){
     // Rendering/access failure after commit cannot restore the retired source.
     onAuthorityLost('admission-not-presented');
     await cleanup(known.roomId,known.arrival,captured);
     if(current())await reconcile().catch(error=>invalidateAuthority(error.status===401?'authentication-required':'reconciliation-failed'));
    }else if(current()&&(!error.status||error.status>=500||errorCode(error)==='RESUME_CONTEXT_CHANGED'||operation.contextChanged)){
     // A lost response is not proof of a failed POST. Read actual session
     // authority, then resume exactly that room; never repeat travel or leave.
     try{if(await reconcile())return true;}catch(error){invalidateAuthority(error.status===401?'authentication-required':'reconciliation-failed');}
    }else if(current()){
     const buffered=operation.buffer?.snapshot();
     if(roomId===captured.roomId&&buffered?.denied){
      invalidateAuthority('source-access-changed');
      await reconcile().catch(error=>invalidateAuthority(error.status===401?'authentication-required':'reconciliation-failed'));
     }else{
      const decision=apply(arrivals.failJoin(operation.ticket));
      if(['adopt','retain'].includes(decision.kind)&&roomId===captured.roomId)onRetained(buffered?.events||[]);
      if(decision.kind==='refresh-required'){onAuthorityLost(decision.reason);await reconcile().catch(error=>invalidateAuthority(error.status===401?'authentication-required':'reconciliation-failed'));}
     }
    }
    if(current()){onError(error);throw error;}return false;
   }finally{
    if(active===operation)active=null;
    await onSettled({committed,failed,current:current(),pending:intent!==sequence,options});
   }
  };
  const promise=queue.then(run,run);queue=promise.catch(()=>{});lastIntent={key,promise};
  promise.finally(()=>{if(lastIntent?.promise===promise)lastIntent=null;}).catch(()=>{});return promise;
 }
 return {navigate,reset,hello,observe,snapshot:()=>arrivals.snapshot(),sourceGeneration:()=>sourceGeneration,isNavigating:()=>!!active};
}
