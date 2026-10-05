import {isDeepStrictEqual} from 'node:util';
import * as v from './validation.mjs';
import {objectFootprint,footprintInside,footprintsOverlap,editablePersonalArea} from '../src/personal-area-policy.js';
const FULL_EDIT=['owner','admin','editor'];
const RESERVED=['ownerId','owner_id','actorId','actor_id','userId','user_id','claimRevision','personalAreaId','createdBy','creatorId','canEdit','canEditObjects','serverData','arrival','admissionId','admissionEpoch','admissionRevision'];
export function validatePersonalScene(scene){
  for(const area of scene.areas??[]){
    for(const key of RESERVED)if(Object.hasOwn(area,key))v.fail(400,'SERVER_OWNED_FIELD',`${key} is controlled by the server`);
    if(area.personalArea===undefined)continue;
    const config=v.record(area.personalArea,'personalArea');
    for(const key of Object.keys(config))if(!['mode','allowedTags'].includes(key))v.fail(400,'SERVER_OWNED_FIELD',`${key} cannot be set in personalArea`);
    v.oneOf(config.mode,['dynamic','static'],'personal area mode');
    const tags=config.allowedTags??[];if(!Array.isArray(tags)||tags.length>30)v.fail(400,'INVALID_TAGS','Use up to 30 allowed world-local tags');
    for(const tag of tags){v.text(tag,'allowed tag',40);if(tag!==tag.trim()||['owner','admin','editor','moderator','member','guest'].includes(tag.toLowerCase()))v.fail(400,'INVALID_TAGS','Use exact world-local custom tags, not permission roles');}
    if(new Set(tags).size!==tags.length)v.fail(400,'INVALID_TAGS','Allowed tags must be unique');
    if(Math.abs(area.x)+area.width/2>scene.bounds.width/2||Math.abs(area.z)+area.depth/2>scene.bounds.depth/2)v.fail(400,'PERSONAL_AREA_BOUNDS','Keep the entire personal area inside the room');
  }
  for(const object of scene.objects)for(const key of RESERVED)if(Object.hasOwn(object,key))v.fail(400,'SERVER_OWNED_FIELD',`${key} is controlled by the server`);
}
export function migratePersonalAreas(store){
  store.db.exec(`CREATE TABLE IF NOT EXISTS personal_areas(room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,area_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,owner_id TEXT REFERENCES users(id),active INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL,PRIMARY KEY(room_id,area_id));
    CREATE TABLE IF NOT EXISTS personal_area_declines(room_id TEXT NOT NULL,area_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),revision INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(room_id,area_id,user_id),FOREIGN KEY(room_id,area_id) REFERENCES personal_areas(room_id,area_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS personal_area_objects(room_id TEXT NOT NULL,object_id TEXT NOT NULL,area_id TEXT NOT NULL,creator_id TEXT NOT NULL REFERENCES users(id),claim_revision INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(room_id,object_id),FOREIGN KEY(room_id,area_id) REFERENCES personal_areas(room_id,area_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS personal_area_operations(user_id TEXT NOT NULL REFERENCES users(id),operation_id TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,operation_id));`);
  for(const row of store.all('SELECT id,scene FROM rooms'))for(const area of JSON.parse(row.scene).areas??[])if(area.personalArea)store.run('INSERT OR IGNORE INTO personal_areas(room_id,area_id,updated_at) VALUES(?,?,?)',row.id,area.id,store.now());
}
function configIdentity(area){return area&&{x:area.x,z:area.z,width:area.width,depth:area.depth,personalArea:area.personalArea};}
export const personalAreaMethods={
  personalAreas(roomOrId,userId){
    const room=typeof roomOrId==='string'?this.roomRow(roomOrId):roomOrId,scene=JSON.parse(room.scene),imageDefinitions=this.imageDefinitions?.(room.id,scene)??{},compositionDefinitions=this.compositionDefinitions?.(room.id,scene)??{};
    const active=this.canSeeRoom(room,userId),manage=active&&FULL_EDIT.includes(this.role(room,userId));
    const tags=JSON.parse(this.worldMembership(room.world_id,userId)?.tags??'[]');
    const rows=new Map(this.all('SELECT * FROM personal_areas WHERE room_id=? AND active=1',room.id).map(r=>[r.area_id,r]));
    return(scene.areas??[]).filter(a=>a.personalArea&&rows.has(a.id)).map(area=>{
      const row=rows.get(area.id),owner=row.owner_id?this.user(row.owner_id):null,decline=this.get('SELECT revision FROM personal_area_declines WHERE room_id=? AND area_id=? AND user_id=?',room.id,area.id,userId),box=area;
      const ownedObjects=new Set(this.all('SELECT object_id FROM personal_area_objects WHERE room_id=? AND area_id=? AND creator_id=? AND claim_revision=?',room.id,area.id,row.owner_id??'',row.revision).map(o=>o.object_id));
      const inside=scene.objects.filter(o=>footprintInside(box,objectFootprint(o,imageDefinitions,compositionDefinitions)));
      return{areaId:area.id,name:area.name,x:area.x,z:area.z,width:area.width,depth:area.depth,mode:area.personalArea.mode,allowedTags:area.personalArea.allowedTags??[],revision:row.revision,ownerId:row.owner_id,owner:owner?{id:owner.id,name:owner.name,username:owner.username}:null,isOwner:row.owner_id===userId,canEditObjects:active&&row.owner_id===userId,canManage:manage,canClaim:active&&!!this.user(userId)?.account&&!row.owner_id&&area.personalArea.mode==='dynamic'&&(!(area.personalArea.allowedTags??[]).length||(area.personalArea.allowedTags??[]).some(tag=>tags.includes(tag))),declined:decline?.revision===row.revision,objectCount:inside.length,ownedObjectCount:inside.filter(o=>ownedObjects.has(o.id)).length,updatedAt:row.updated_at};
    });
  },
  syncPersonalAreas(roomId,before,next){
    const old=new Map((before?.areas??[]).filter(a=>a.personalArea).map(a=>[a.id,a])),fresh=new Map((next.areas??[]).filter(a=>a.personalArea).map(a=>[a.id,a]));
    for(const row of this.all('SELECT * FROM personal_areas WHERE room_id=? AND active=1',roomId)){
      const a=fresh.get(row.area_id);if(!a||!isDeepStrictEqual(configIdentity(old.get(row.area_id)),configIdentity(a))){
        const previous=old.get(row.area_id),sameGeometry=a&&previous&&['x','z','width','depth'].every(k=>a[k]===previous[k]);
        if(row.owner_id&&(!sameGeometry||a.personalArea.mode!==previous.personalArea.mode))v.fail(409,'PERSONAL_AREA_CLAIMED','Revoke this personal area before changing its bounds or mode, or deleting it',{areaId:row.area_id});
        // Eligibility changes do not revoke a separately granted owner. Preserve
        // attribution across this revision of the same ownership grant.
        if(row.owner_id)this.run('UPDATE personal_area_objects SET claim_revision=? WHERE room_id=? AND area_id=? AND creator_id=? AND claim_revision=?',row.revision+1,roomId,row.area_id,row.owner_id,row.revision);
        this.run('UPDATE personal_areas SET active=?,revision=revision+1,updated_at=? WHERE room_id=? AND area_id=?',a?1:0,this.now(),roomId,row.area_id);
      }
    }
    for(const area of fresh.values()){
      const row=this.get('SELECT * FROM personal_areas WHERE room_id=? AND area_id=?',roomId,area.id);
      if(!row)this.run('INSERT INTO personal_areas(room_id,area_id,updated_at) VALUES(?,?,?)',roomId,area.id,this.now());
      else if(!row.active)this.run('UPDATE personal_areas SET active=1,owner_id=NULL,revision=revision+1,updated_at=? WHERE room_id=? AND area_id=?',this.now(),roomId,area.id);
    }
  },
  validatePersonalObjectDelta(room,userId,before,next,expected,beforeImages={},nextImages={},beforeCompositions={},nextCompositions={}){
    const full=FULL_EDIT.includes(this.role(room,userId));
    if(full)return;
    const areas=this.personalAreas(room,userId);if(!areas.some(a=>a.canEditObjects))v.fail(403,'ROOM_FORBIDDEN','You do not have permission to build in this room');
    const {objects:oldObjects,...oldOther}=before,{objects:newObjects,...newOther}=next;
    if(!isDeepStrictEqual(oldOther,newOther))v.fail(403,'PERSONAL_AREA_ONLY','Personal-area ownership only allows object edits inside your own area');
    const revisions=v.record(expected,'personalAreaRevisions'),old=new Map(oldObjects.map(o=>[o.id,o])),fresh=new Map(newObjects.map(o=>[o.id,o]));
    const allowed=new Set(['id','type','name','x','y','z','rotation','rotationY','width','height','depth','scale','color','text','url','target','entry','document','actions','assetRef']);
    for(const objectId of new Set([...old.keys(),...fresh.keys()])){
      const a=old.get(objectId),b=fresh.get(objectId);if(isDeepStrictEqual(a,b))continue;
      for(const object of [a,b].filter(Boolean)){
        if(object===b)for(const key of Object.keys(object))if(!allowed.has(key))v.fail(400,'INVALID_OBJECT_FIELD',`${key} is not an editable object field`);
        const area=editablePersonalArea(areas,object,userId,object===a?beforeImages:nextImages,object===a?beforeCompositions:nextCompositions);if(!area)v.fail(403,'OBJECT_OUTSIDE_PERSONAL_AREA','Keep the entire object inside your personal area and outside other owners’ areas',{objectId});
        if(revisions[area.areaId]!==area.revision)v.fail(409,'PERSONAL_AREA_CONFLICT','Your personal-area access changed. Refresh before saving.',{areaId:area.areaId,room:this.room(room.id,userId)});
      }
    }
  },
  recordPersonalObjects(roomId,userId,before,next,imageDefinitions={},compositionDefinitions={}){
    const old=new Set(before.objects.map(o=>o.id)),current=new Set(next.objects.map(o=>o.id));
    for(const row of this.all('SELECT object_id FROM personal_area_objects WHERE room_id=?',roomId))if(!current.has(row.object_id))this.run('DELETE FROM personal_area_objects WHERE room_id=? AND object_id=?',roomId,row.object_id);
    const areas=this.personalAreas(roomId,userId);
    for(const object of next.objects)if(!old.has(object.id)){
      const box=objectFootprint(object,imageDefinitions,compositionDefinitions),area=areas.find(a=>a.ownerId&&footprintInside(a,box)&&!areas.some(b=>b.areaId!==a.areaId&&b.ownerId&&b.ownerId!==a.ownerId&&footprintsOverlap(b,box)));
      if(area)this.run('INSERT INTO personal_area_objects(room_id,object_id,area_id,creator_id,claim_revision,created_at) VALUES(?,?,?,?,?,?)',roomId,object.id,area.areaId,userId,area.revision,this.now());
    }
  },
};
