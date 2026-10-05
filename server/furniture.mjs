import {randomUUID,createHash} from 'node:crypto';
import {validate,serialize,triangleCount} from '../modules/asset-workshop/model.js';
import {validateCompositionObject} from '../src/composition-geometry.js';
import {bindCompositionDefinitions} from '../src/composition-context.js';
import {canonicalStringify} from '../src/scene-operations.js';
import * as v from './validation.mjs';

// Archived entries and historical revisions still consume durable budgets.
export const FURNITURE_LIMITS=Object.freeze({assets:64,revisionsPerAsset:32,roomRevisions:512,definitionBytes:262144,roomDefinitionBytes:8*1024*1024,roomDefinitionTriangles:2*1024*1024,instances:128,instanceComponents:2048,instanceTriangles:262144,sceneDefinitionBytes:4*1024*1024});
const fullEdit=['owner','admin','editor'];
const hasCompositions=scene=>Array.isArray(scene?.objects)&&scene.objects.some(object=>object?.type==='composition');
const key=ref=>`${ref.assetId}:${ref.revision}`;
const hash=value=>createHash('sha256').update(canonicalStringify(value)).digest('hex');
function exact(value,keys){v.record(value);if(Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(value,k)))v.fail(400,'INVALID_FURNITURE','Use only the required furniture request fields');}
function validateDoc(input){try{return validate(input);}catch(error){v.fail(400,'INVALID_FURNITURE',error.message);}}
function validateObject(input){try{return validateCompositionObject(input);}catch(error){v.fail(400,'INVALID_COMPOSITION',error.message);}}
function deepFreeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;}

export function createRoomFurniture({store,session,arrivals,presence,now,body,send,emitRoom}){
 store.db.exec(`
  CREATE TABLE IF NOT EXISTS room_furniture_assets(room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,asset_id TEXT NOT NULL,author_id TEXT NOT NULL REFERENCES users(id),revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','archived')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(room_id,asset_id));
  CREATE TABLE IF NOT EXISTS room_furniture_revisions(room_id TEXT NOT NULL,asset_id TEXT NOT NULL,revision INTEGER NOT NULL,definition TEXT NOT NULL,byte_length INTEGER NOT NULL,triangles INTEGER NOT NULL,components INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(room_id,asset_id,revision),FOREIGN KEY(room_id,asset_id) REFERENCES room_furniture_assets(room_id,asset_id) ON DELETE CASCADE);
  CREATE TRIGGER IF NOT EXISTS room_furniture_revision_immutable BEFORE UPDATE ON room_furniture_revisions BEGIN SELECT RAISE(ABORT,'Furniture revisions are immutable'); END;
  CREATE TABLE IF NOT EXISTS room_furniture_receipts(actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,operation_id TEXT NOT NULL,room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(actor_id,operation_id));
 `);
 let policyEpoch=0;
 function captureFence(s){return{arrival:arrivals.captureFence(s),policyEpoch};}
 function checkFence(s,fence,roomId){
  if(!fence||fence.policyEpoch!==policyEpoch)v.fail(409,'FURNITURE_AUTHORITY_CHANGED','Room access changed while this request was in progress');
  const live=arrivals.checkFence(s,fence.arrival),person=presence.get(`${roomId}:${s.user_id}`);
  if(live.current_room_id!==roomId||!person||now()-person.lastSeen>=60000||!person.admissionId)v.fail(409,'FURNITURE_JOIN_REQUIRED','Join this room with a current arrival before saving furniture');
  store.authorize(roomId,s.user_id);return live;
 }
 function entry(roomId,assetId,revision){
  const row=store.get(`SELECT a.*,r.definition,r.created_at AS version_created_at FROM room_furniture_assets a JOIN room_furniture_revisions r ON r.room_id=a.room_id AND r.asset_id=a.asset_id WHERE a.room_id=? AND a.asset_id=? AND r.revision=?`,roomId,assetId,revision);
  if(!row)v.fail(404,'FURNITURE_NOT_FOUND','This furniture revision is unavailable in this room');
  return{assetId:row.asset_id,roomId:row.room_id,authorId:row.author_id,revision,status:row.status,definition:validateDoc(JSON.parse(row.definition)),createdAt:row.created_at,updatedAt:row.updated_at};
 }
 function definitions(roomId,scene,{previousScene,allowArchived=true,enforceBudget=false}={}){
  const result=Object.create(null),previous=new Map((previousScene?.objects??[]).map(object=>[object.id,object]));
  if(!Array.isArray(scene?.objects))v.fail(400,'INVALID_SCENE','scene.objects must be an array');
  let instances=0,components=0,triangles=0,bytes=0;
  for(const raw of scene.objects){
   if(raw?.type!=='composition')continue;
   const object=validateObject(raw),ref=object.assetRef,reference=key(ref);
   const row=store.get(`SELECT a.status,r.definition,r.byte_length,r.triangles,r.components FROM room_furniture_assets a JOIN room_furniture_revisions r ON r.room_id=a.room_id AND r.asset_id=a.asset_id WHERE a.room_id=? AND a.asset_id=? AND r.revision=?`,roomId,ref.assetId,ref.revision);
   if(!row)v.fail(404,'FURNITURE_NOT_FOUND','This furniture revision is unavailable in this room');
   const prior=previous.get(object.id),alreadyPinned=prior?.type==='composition'&&prior.assetRef?.assetId===ref.assetId&&prior.assetRef?.revision===ref.revision;
   if(row.status==='archived'&&!allowArchived&&!alreadyPinned)v.fail(409,'FURNITURE_ARCHIVED','Archived furniture can stay in saved scenes but cannot be newly placed');
   instances++;components+=row.components;triangles+=row.triangles;
   if(!Object.hasOwn(result,reference)){result[reference]=validateDoc(JSON.parse(row.definition));bytes+=row.byte_length;}
   if(enforceBudget&&(instances>FURNITURE_LIMITS.instances||components>FURNITURE_LIMITS.instanceComponents||triangles>FURNITURE_LIMITS.instanceTriangles||bytes>FURNITURE_LIMITS.sceneDefinitionBytes))v.fail(413,'FURNITURE_SCENE_BUDGET','This room exceeds its custom furniture placement budget');
  }
  return deepFreeze(result);
 }
 store.compositionDefinitions=definitions;
 const projectRoom=store.room.bind(store);
 store.room=(rowOrId,userId,includeScene=true)=>{
  const room=projectRoom(rowOrId,userId,includeScene),compositionDefinitions=includeScene?definitions(room.id,room.scene):Object.freeze(Object.create(null));
  if(includeScene)bindCompositionDefinitions(room.scene,compositionDefinitions,room.id);
  return{...room,compositionDefinitions};
 };
 function resolveScenePair({roomId,live,before,next,fence}){
  if(!store.db.isTransaction)throw new Error('Furniture scene resolution requires a scene CAS transaction');
  if(!hasCompositions(before)&&!hasCompositions(next))return{before:Object.freeze(Object.create(null)),next:Object.freeze(Object.create(null))};
  checkFence(live,fence,roomId);
  const resolved={before:definitions(roomId,before),next:definitions(roomId,next,{previousScene:before,allowArchived:false,enforceBudget:true})};
  bindCompositionDefinitions(before,resolved.before,roomId);bindCompositionDefinitions(next,resolved.next,roomId);return resolved;
 }
 function libraryBudget(roomId,{isNew,assetId,bytes,triangles}){
  const assets=store.get('SELECT COUNT(*) AS count FROM room_furniture_assets WHERE room_id=?',roomId).count;
  const totals=store.get('SELECT COUNT(*) AS count,COALESCE(SUM(byte_length),0) AS bytes,COALESCE(SUM(triangles),0) AS triangles FROM room_furniture_revisions WHERE room_id=?',roomId);
  const versions=isNew?0:store.get('SELECT COUNT(*) AS count FROM room_furniture_revisions WHERE room_id=? AND asset_id=?',roomId,assetId).count;
  if(isNew&&assets>=FURNITURE_LIMITS.assets||versions>=FURNITURE_LIMITS.revisionsPerAsset||totals.count>=FURNITURE_LIMITS.roomRevisions||totals.bytes+bytes>FURNITURE_LIMITS.roomDefinitionBytes||totals.triangles+triangles>FURNITURE_LIMITS.roomDefinitionTriangles)v.fail(413,'FURNITURE_LIBRARY_BUDGET','This room has reached its custom furniture library budget');
 }
 async function handle(req,res,url,s){
  const match=url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/furniture(?:\/([A-Za-z0-9_-]+)(?:\/(archive))?)?$/);
  if(!match)return false;
  const[,roomId,assetId,action]=match;store.authorize(roomId,s.user_id);
  if(req.method==='GET'&&!assetId){
   const assets=store.all('SELECT asset_id,revision FROM room_furniture_assets WHERE room_id=? ORDER BY created_at,asset_id',roomId).map(row=>entry(roomId,row.asset_id,row.revision));
   send(res,200,{assets,limits:FURNITURE_LIMITS});return true;
  }
  const create=req.method==='POST'&&!assetId,update=req.method==='PUT'&&!!assetId&&!action,archive=req.method==='POST'&&action==='archive';
  if(!create&&!update&&!archive)v.fail(405,'METHOD_NOT_ALLOWED','Use GET/POST for the library, PUT for a revision, or POST archive');
  store.authorize(roomId,s.user_id,fullEdit);
  const fence=captureFence(s);checkFence(s,fence,roomId);
  if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')v.fail(415,'UNSUPPORTED_ENCODING','Use an uncompressed JSON request');
  const payload=await body(req);exact(payload,create?['definition','operationId']:archive?['revision','operationId']:['definition','revision','operationId']);
  v.id(payload.operationId,'operationId');if(!create)v.integer(payload.revision,'revision',1,1000000);
  const draft=archive?null:validateDoc(payload.definition);
  if(draft&&!draft.components.length)v.fail(400,'EMPTY_FURNITURE','Add at least one component before publishing furniture');
  const requestHash=hash({roomId,assetId:assetId??null,action:archive?'archive':create?'create':'update',...payload});
  const result=store.transaction(()=>{
   const live=session(req);if(live.token_hash!==s.token_hash||live.user_id!==s.user_id)v.fail(401,'AUTH_REQUIRED');
   checkFence(live,fence,roomId);store.authorize(roomId,s.user_id,fullEdit);
   const receipt=store.get('SELECT * FROM room_furniture_receipts WHERE actor_id=? AND operation_id=?',s.user_id,payload.operationId);
   if(receipt){if(receipt.room_id!==roomId||receipt.request_hash!==requestHash)v.fail(409,'OPERATION_REUSED','This operation ID already identifies a different furniture change');return{asset:JSON.parse(receipt.result),duplicate:true};}
   const current=create?null:store.get('SELECT * FROM room_furniture_assets WHERE room_id=? AND asset_id=?',roomId,assetId);
   if(!create&&!current)v.fail(404,'FURNITURE_NOT_FOUND','This furniture is unavailable in this room');
   if(current&&current.revision!==payload.revision)v.fail(409,'FURNITURE_REVISION_CONFLICT','Furniture changed. Reload the current source before saving.',{asset:entry(roomId,assetId,current.revision)});
   if(current?.status==='archived')v.fail(409,'FURNITURE_ARCHIVED','Save a copy to publish archived furniture again');
   const id=create?randomUUID():assetId,revision=create?1:archive?current.revision:current.revision+1,timestamp=now();
   if(archive)store.run("UPDATE room_furniture_assets SET status='archived',updated_at=? WHERE room_id=? AND asset_id=?",timestamp,roomId,id);
   else{
    draft.asset={...draft.asset,id,revision};const definition=serialize(validateDoc(draft)),bytes=Buffer.byteLength(definition),triangles=triangleCount(draft);
    if(bytes>FURNITURE_LIMITS.definitionBytes)v.fail(413,'FURNITURE_DEFINITION_BUDGET','The published definition exceeds the byte budget');
    libraryBudget(roomId,{isNew:create,assetId:id,bytes,triangles});
    if(create)store.run("INSERT INTO room_furniture_assets(room_id,asset_id,author_id,revision,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?)",roomId,id,s.user_id,revision,timestamp,timestamp);
    else store.run('UPDATE room_furniture_assets SET revision=?,updated_at=? WHERE room_id=? AND asset_id=?',revision,timestamp,roomId,id);
    store.run('INSERT INTO room_furniture_revisions(room_id,asset_id,revision,definition,byte_length,triangles,components,created_at) VALUES(?,?,?,?,?,?,?,?)',roomId,id,revision,definition,bytes,triangles,draft.components.length,timestamp);
   }
   const asset=entry(roomId,id,revision);
   store.run('INSERT INTO room_furniture_receipts(actor_id,operation_id,room_id,request_hash,result,created_at) VALUES(?,?,?,?,?,?)',s.user_id,payload.operationId,roomId,requestHash,JSON.stringify(asset),timestamp);
   return{asset,duplicate:false};
  });
  if(!result.duplicate)emitRoom(roomId,'furniture',{roomId,assetId:result.asset.assetId,revision:result.asset.revision,status:result.asset.status});
  send(res,create&&!result.duplicate?201:200,result);return true;
 }
 return Object.freeze({handle,captureFence,resolveScenePair,policyChanged(){policyEpoch++;},definitions});
}
