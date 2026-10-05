import {createHash} from 'node:crypto';
import {canonicalStringify,sceneOperationContext,sceneOperationDependencyView,sceneOperationRequestIdentity,validateSceneOperationBatch,applySceneOperations} from '../src/scene-operations.js';
import {replaySceneOperations} from './scene-operation-store.mjs';
import * as v from './validation.mjs';
const hash=value=>createHash('sha256').update(canonicalStringify(value)).digest('hex');
const receipt=row=>({version:row.protocol_version,operationId:row.operation_id,actorId:row.actor_id,roomId:row.room_id,appliedRevision:row.applied_revision,requestHash:row.request_hash});

export function createSceneOperationService({store,session,arrivals,images,furniture,furnitureProtocol,body,send,commitScene,afterCommit}) {
 const conflict=(roomId,userId,conflicts,message='The scene changed. Review the conflicting items before saving.')=>v.fail(409,'SCENE_OPERATION_CONFLICT',message,{room:store.room(roomId,userId),conflicts});
 return async function handle(req,res,url,s) {
  const match=url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/scene\/operations$/);
  if(!match)return false;
  const roomId=match[1],userId=s.user_id;
  store.authorize(roomId,userId);
  if(req.method==='GET'){
   const raw=url.searchParams.get('after')??'0';if(!/^\d+$/.test(raw))v.fail(400,'INVALID_CURSOR','Use a nonnegative scene revision');
   const after=v.integer(Number(raw),'after');
   const live=session(req);if(live.user_id!==userId)v.fail(401,'AUTH_REQUIRED');
   send(res,200,replaySceneOperations(store,roomId,userId,after));return true;
  }
  if(req.method!=='POST')v.fail(405,'METHOD_NOT_ALLOWED','Use GET or POST for scene operations');
  const fence=arrivals.captureFence(s),imageSessionEpoch=images.sessionEpoch(s.token_hash),furnitureFence=furniture.captureFence(s),batch=await body(req);
  try{validateSceneOperationBatch(batch);}catch(error){v.fail(400,error.code??'INVALID_SCENE_OPERATIONS',error.message);}
  const requestHash=hash(sceneOperationRequestIdentity(roomId,batch));
  const result=store.transaction(()=>{
   const live=session(req);if(live.user_id!==userId||live.token_hash!==s.token_hash)v.fail(401,'AUTH_REQUIRED');
   const {row}=store.authorize(roomId,userId);
   if(!store.roomCapabilities(row,userId).canBuild)v.fail(403,'ROOM_FORBIDDEN','You do not have permission to build in this room');
   // Both current live admission and the pre-stream fence apply before receipt
   // lookup. A committed operation can be retried using a fresh admission;
   // a retired request cannot execute (or reveal a stale authorized snapshot).
   if(!arrivals.matchesPlacement(live,roomId,batch.admission,fence))v.fail(409,'STALE_ARRIVAL','Join this room with the current admission before saving');
   const prior=store.get('SELECT * FROM scene_operation_receipts WHERE actor_id=? AND operation_id=?',userId,batch.operationId);
   if(prior){
    if(prior.room_id!==roomId||prior.request_hash!==requestHash)v.fail(409,'OPERATION_REUSED','This operation ID already identifies a different scene commit');
    return {room:store.room(row,userId),receipt:receipt(prior),duplicate:true};
   }
   const before=JSON.parse(row.scene),conflicts=[];
   if(batch.baseRevision>row.revision||hash(sceneOperationContext(before,batch.version))!==batch.contextHash)conflicts.push({kind:'context'});
   const objects=new Map(before.objects.map(object=>[object.id,object])),areas=new Map((before.areas??[]).map(area=>[area.id,area])),cells=new Map((before.terrain?.cells??[]).map(cell=>[`${cell[0]},${cell[1]}`,cell]));
   for(const operation of batch.operations){
    if(operation.kind==='object'||operation.kind==='area'){
     const current=(operation.kind==='object'?objects:areas).get(operation.id),expected=current?hash(current):null;
     if(expected!==operation.before)conflicts.push({kind:operation.kind,id:operation.id});
     if(operation.after!==null&&hash(operation.after)===operation.before)v.fail(400,'INVALID_SCENE_OPERATIONS','Operations must change the target');
    }else if(operation.kind==='scene'){
     const expected=Object.hasOwn(before,operation.field)?hash(before[operation.field]):null;
     if(expected!==operation.before)conflicts.push({kind:'scene',field:operation.field});
     if(operation.after!==null&&hash(operation.after)===operation.before)v.fail(400,'INVALID_SCENE_OPERATIONS','Operations must change the target');
    }else if(canonicalStringify(cells.get(`${operation.x},${operation.z}`)??null)!==canonicalStringify(operation.before))conflicts.push({kind:'terrain',x:operation.x,z:operation.z});
   }
   if(conflicts.length)conflict(roomId,userId,conflicts);
   const next=applySceneOperations(before,batch.operations);
   const saved=commitScene({row,userId,live,before,next,personalAreaRevisions:batch.personalAreaRevisions,imageSessionEpoch,furnitureFence,furnitureCapable:furnitureProtocol.accepts(req),validateGeometry:true,
    validateDependencies:batch.version===2?(resolvedImages,resolvedCompositions)=>{
     let dependencies;
     try{dependencies=sceneOperationDependencyView(before,batch.operations,{...resolvedImages.before,...resolvedImages.next},{...resolvedCompositions.before,...resolvedCompositions.next});}catch(error){v.fail(400,error.code??'INVALID_SCENE_OPERATIONS',error.message);}
     if(hash(dependencies)!==batch.dependenciesHash)conflict(roomId,userId,[{kind:'dependencies'}],'Nearby areas, objects, ground or room geometry changed. Review their combined behavior before saving.');
    }:undefined,
    conflict:targets=>conflict(roomId,userId,targets,'These changes overlap or block the current scene. Review their placement before saving.')});
   store.run('INSERT INTO scene_operation_receipts(actor_id,operation_id,room_id,request_hash,applied_revision,protocol_version) VALUES(?,?,?,?,?,?)',userId,batch.operationId,roomId,requestHash,saved.room.revision,batch.version);
   return {...saved,receipt:{version:batch.version,operationId:batch.operationId,actorId:userId,roomId,appliedRevision:saved.room.revision,requestHash},duplicate:false};
  });
  if(!result.duplicate)afterCommit(roomId,userId,result.room,result.questChanges);
  send(res,200,{room:result.room,receipt:result.receipt,duplicate:result.duplicate});return true;
 };
}
