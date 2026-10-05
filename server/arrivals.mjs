import {randomUUID} from 'node:crypto';
import {bindImageDefinitions} from '../src/image-asset-context.js';
import {bindCompositionDefinitions} from '../src/composition-context.js';
import {entryCatalog,resolveArrival,validateEntryKey,validateArrivalGeometry} from '../src/arrivals.js';
import * as v from './validation.mjs';
const translate=(error,status=409)=>{if(error.status)throw error;v.fail(status,error.code??'ARRIVAL_BLOCKED',error.message,{...(error.entry!==undefined?{entry:error.entry}:{}),...(error.attempted!==undefined?{attempted:error.attempted}:{})});};
export function readArrivalInput(input){
 v.record(input);
 for(const key of Object.keys(input))if(!['entry','mode','sourceAction'].includes(key))v.fail(400,'INVALID_INPUT',`${key} cannot be set on an arrival`);
 if(input.mode!==undefined)v.oneOf(input.mode,['travel','resume','enter'],'arrival mode');
 if(input.entry!==undefined){try{validateEntryKey(input.entry);}catch(error){translate(error,400);}}
 if(['resume','enter'].includes(input.mode)&&(input.entry!==undefined||input.sourceAction!==undefined))v.fail(400,'INVALID_INPUT',`${input.mode==='resume'?'Resume':'Default entry'} cannot select a named arrival or travel action`);
 if(input.sourceAction!==undefined){
  v.record(input.sourceAction,'sourceAction');
  for(const key of Object.keys(input.sourceAction))if(!['roomId','revision','entityType','entityId','actionId'].includes(key))v.fail(400,'INVALID_INPUT',`${key} cannot be set on a source action`);
  v.id(input.sourceAction.roomId,'source room');
 }
 return input;
}
export function readExpectedPlacement(input){
 v.record(input);
 const fields=['admissionId','admissionEpoch','admissionRevision'];
 for(const key of Object.keys(input))if(!fields.includes(key))v.fail(400,'INVALID_INPUT',`${key} cannot be set on placement cleanup`);
 if(!Object.keys(input).length)return null;
 v.id(input.admissionId,'admissionId');v.id(input.admissionEpoch,'admissionEpoch');v.integer(input.admissionRevision,'admissionRevision',1);
 return Object.fromEntries(fields.map(key=>[key,input[key]]));
}
export function createArrivalService({store,presence,now,residents=()=>[]}){
 // Protocol opt-in lasts for the authenticated session, not its presence TTL.
 // Foreign-key deletion bounds this durable set to real sessions; no per-room
 // tombstones survive logout/expiry, and placement coordinates remain ephemeral.
 store.db.exec('CREATE TABLE IF NOT EXISTS arrival_session_guards(token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE)');
 const epoch=randomUUID(),epochs=new Map(),records=new Map();let sequence=0;
 function captureFence(s){const person=presence.get(`${s.current_room_id}:${s.user_id}`);return{roomId:s.current_room_id,epoch:epochs.get(s.token_hash)??0,admissionId:person?.admissionId??null,admissionEpoch:person?.admissionEpoch??null,admissionRevision:person?.admissionRevision??null};}
 function checkFence(s,fence){
  const live=store.get('SELECT * FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?',s.token_hash,s.user_id,now());
  if(!live)v.fail(401,'AUTH_REQUIRED');
  const current=captureFence(live);
  if(current.roomId!==fence.roomId||current.epoch!==fence.epoch||current.admissionId!==fence.admissionId||current.admissionEpoch!==fence.admissionEpoch||current.admissionRevision!==fence.admissionRevision)v.fail(409,'STALE_ARRIVAL','Your arrival changed while this request was in progress');
  return live;
 }
 function matchesPlacement(s,roomId,expected,fence){
  let live;try{live=checkFence(s,fence);}catch(error){if(error.code==='STALE_ARRIVAL')return false;throw error;}
  if(live.current_room_id!==roomId)return false;
  const person=presence.get(`${roomId}:${live.user_id}`);
  return !!person&&now()-person.lastSeen<60000&&['admissionId','admissionEpoch','admissionRevision'].every(key=>person[key]===expected[key]);
 }
 function retire(token){epochs.set(token,(epochs.get(token)??0)+1);}
 function catalog(roomId,userId){const {row}=store.authorize(roomId,userId);return{roomId,revision:row.revision,entries:entryCatalog(JSON.parse(row.scene))};}
 function prepare(roomId,userId,{entry,resume=false,strict=false,sessionToken=null,retiringAccountId=null}={}){
  const {row}=store.authorize(roomId,userId),key=`${roomId}:${userId}`,old=presence.get(key),prior=records.get(key);
  strict ||= !!prior?.strict||!!store.get('SELECT 1 FROM arrival_session_guards g JOIN sessions s ON s.token_hash=g.token_hash WHERE s.user_id=? AND s.expires_at>? AND (s.current_room_id=? OR s.token_hash=?)',userId,now(),roomId,sessionToken??'');
  if(resume&&old&&now()-old.lastSeen<60000&&Number.isFinite(old.x)&&Number.isFinite(old.z)){
   const admissionId=old.admissionId??randomUUID(),admissionRevision=old.admissionEpoch===epoch&&Number.isSafeInteger(old.admissionRevision)?old.admissionRevision:++sequence;
   return{...prior?.arrival,x:old.x,z:old.z,requestedEntry:null,entry:prior?.arrival.entry??null,areaId:prior?.arrival.areaId??null,source:'resume',fallback:null,resumed:true,admissionId,admissionEpoch:epoch,admissionRevision,strict:strict||!!prior?.strict};
  }
  const scene=JSON.parse(row.scene);bindImageDefinitions(scene,store.imageDefinitions?.(roomId,scene)??{},roomId);bindCompositionDefinitions(scene,store.compositionDefinitions?.(roomId,scene)??{},roomId);
  const occupants=[...presence.values()].filter(p=>p.roomId===roomId&&p.userId!==userId&&now()-p.lastSeen<60000
    &&store.get('SELECT 1 FROM sessions WHERE user_id=? AND current_room_id=? AND expires_at>?',p.userId,roomId,now())&&store.canSeeRoom(row,p.userId));
  occupants.push(...residents(roomId,{retiringAccountId}).filter(p=>p.kind==='bot'&&Number.isFinite(p.x)&&Number.isFinite(p.z)));
  try{return{...resolveArrival(scene,{entry,occupants,seed:randomUUID()}),admissionId:randomUUID(),admissionEpoch:epoch,admissionRevision:++sequence,strict:strict||!!prior?.strict};}catch(error){translate(error);}
 }
 function commit(roomId,userId,prepared,sessionToken=null){
  const {strict,...arrival}=prepared;
  if(strict)store.run('INSERT OR IGNORE INTO arrival_session_guards(token_hash) SELECT token_hash FROM sessions WHERE user_id=? AND expires_at>? AND (current_room_id=? OR token_hash=?)',userId,now(),roomId,sessionToken??'');
  records.set(`${roomId}:${userId}`,{arrival,strict});return arrival;
 }
 function authorizeMovement(s,input){
  const person=presence.get(`${s.current_room_id}:${s.user_id}`),record=records.get(`${s.current_room_id}:${s.user_id}`);
  if(!person||now()-person.lastSeen>=60000)v.fail(409,'POSITION_UNCONFIRMED','Resume this room to confirm a safe arrival before moving');
  if(input.admissionId!==undefined)v.id(input.admissionId,'admissionId');
  if((record?.strict||input.admissionId!==undefined)&&input.admissionId!==person?.admissionId)v.fail(409,'STALE_ARRIVAL','Use the current arrival before sending movement');
 }
 function validateScene(scene,definitions,roomId){bindImageDefinitions(scene,definitions,roomId);try{validateArrivalGeometry(scene);}catch(error){translate(error,400);}}
 function sweep(){for(const token of epochs.keys())if(!store.get('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?',token,now()))epochs.delete(token);for(const key of records.keys())if(!presence.has(key))records.delete(key);}
 return{epoch,captureFence,checkFence,matchesPlacement,retire,catalog,prepare,commit,authorizeMovement,validateScene,sweep};
}
