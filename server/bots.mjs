import {randomUUID,createHash} from 'node:crypto';
import * as v from './validation.mjs';
import {AVATAR_PRESETS,DEFAULT_APPEARANCE,validateAppearance} from '../src/avatar-spec.js';
import {distance,navigationPolicy,planBotPath,segmentClear} from './bot-navigation.mjs';
import {unavailableResidentTest} from './resident-turns.mjs';
import {bindImageDefinitions} from '../src/image-asset-context.js';

export const MAX_ROOM_BOTS=24;
const TOOLS=['pause','resume','return'];
const CONFIG_KEYS=['name','enabled','appearance','spawn','radius','responseRadius','behavior','waypoints','speed','pauseMs','loop','respondToPlayers','privateInstructions','modelPermissions','permissions','restrictedAreaIds'];
const clone=value=>structuredClone(value);
function strict(value,keys,label='body'){v.record(value,label);for(const key of Object.keys(value))if(!keys.includes(key))v.fail(400,'INVALID_BOT_FIELD',`${key} is not an editable ${label} field`);return value;}
function point(value,label,scene){strict(value,['x','z'],label);return{x:v.finite(value.x,`${label}.x`,-scene.bounds.width/2,scene.bounds.width/2),z:v.finite(value.z,`${label}.z`,-scene.bounds.depth/2,scene.bounds.depth/2)};}
function defaults(scene){return {name:'New resident',enabled:true,appearance:clone(DEFAULT_APPEARANCE),spawn:{...scene.spawn},radius:6,responseRadius:3,behavior:'idle',waypoints:[],speed:1.5,pauseMs:1000,loop:true,respondToPlayers:true,privateInstructions:'',modelPermissions:{pause:false,resume:false,return:false},permissions:{pause:true,resume:true,return:true},restrictedAreaIds:[]};}
export function validateBotConfig(input,scene,previous=null){
  strict(input,CONFIG_KEYS,'configuration');const c={...(previous??defaults(scene)),...input};
  c.name=v.text(c.name,'name',60);c.enabled=v.boolean(c.enabled,'enabled');c.appearance=validateAppearance(c.appearance);c.spawn=point(c.spawn,'spawn',scene);
  c.radius=v.finite(c.radius,'radius',0,100);c.responseRadius=v.finite(c.responseRadius,'responseRadius',0,20);
  c.behavior=v.oneOf(c.behavior,['idle','patrol','social'],'behavior');c.speed=v.finite(c.speed,'speed',.2,4);c.pauseMs=v.integer(c.pauseMs,'pauseMs',0,60000);
  c.loop=v.boolean(c.loop,'loop');c.respondToPlayers=v.boolean(c.respondToPlayers,'respondToPlayers');c.privateInstructions=v.text(c.privateInstructions,'privateInstructions',4000,{empty:true});
  c.modelPermissions=c.modelPermissions??{pause:false,resume:false,return:false};strict(c.modelPermissions,TOOLS,'modelPermissions');c.modelPermissions=Object.fromEntries(TOOLS.map(k=>[k,v.boolean(c.modelPermissions[k],`modelPermissions.${k}`)]));
  strict(c.permissions,TOOLS,'permissions');c.permissions=Object.fromEntries(TOOLS.map(k=>[k,v.boolean(c.permissions[k],`permissions.${k}`)]));
  if(!Array.isArray(c.restrictedAreaIds)||c.restrictedAreaIds.length>100)v.fail(400,'INVALID_BOT_AREAS','Choose up to 100 restricted areas');
  const areaIds=new Set((scene.areas??[]).map(a=>a.id));c.restrictedAreaIds=[...new Set(c.restrictedAreaIds.map(id=>v.id(id,'restricted area')))];
  if(c.enabled&&c.restrictedAreaIds.some(id=>!areaIds.has(id)))v.fail(400,'INVALID_BOT_AREAS','A restricted area no longer exists in this room');
  if(!Array.isArray(c.waypoints)||c.waypoints.length>64)v.fail(400,'INVALID_BOT_ROUTE','Use up to 64 ordered waypoints');
  c.waypoints=c.waypoints.map((p,i)=>point(p,`waypoint ${i+1}`,scene));
  if(c.enabled&&c.behavior==='patrol'&&c.waypoints.length===0)v.fail(400,'INVALID_BOT_ROUTE','Add at least one waypoint for patrol');
  const allowed=navigationPolicy(scene,c);if(c.enabled&&!allowed(c.spawn))v.fail(400,'BOT_SPAWN_BLOCKED','Place the resident on clear ground outside restricted areas');
  if(c.enabled&&c.waypoints.some(p=>!allowed(p)))v.fail(400,'BOT_ROUTE_BLOCKED','Keep every waypoint on clear ground inside the assigned radius and outside restricted areas');
  return c;
}
function migrate(store){store.db.exec(`
  CREATE TABLE IF NOT EXISTS room_bots(id TEXT PRIMARY KEY,room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 0,config TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER);
  CREATE INDEX IF NOT EXISTS room_bot_catalog ON room_bots(room_id,deleted_at);
  CREATE TABLE IF NOT EXISTS bot_operations(user_id TEXT NOT NULL REFERENCES users(id),operation_id TEXT NOT NULL,payload_hash TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,operation_id));
`);}
const record=row=>({id:row.id,roomId:row.room_id,revision:row.revision,modelPermissions:{pause:false,resume:false,return:false},...JSON.parse(row.config),createdAt:row.created_at,updatedAt:row.updated_at});
export function createBotService({store,presence,body,send,session,emitRoom=()=>{},now=Date.now,autoTick=true,onChanged=()=>{},residentTest=unavailableResidentTest}={}){
  migrate(store);const runtime=new Map(),lastPublished=new Map(),commandRates=new Map();let closed=false,lastTick=now();
  function roomScene(room){const scene=JSON.parse(room.scene);return bindImageDefinitions(scene,store.imageDefinitions?.(room.id,scene)??{},room.id);}
  function authorize(roomId,userId){
    const {row}=store.authorize(roomId,userId),role=store.worldRole(store.worldRow(row.world_id),userId);
    if(!['owner','admin','editor'].includes(role))v.fail(403,'BOT_FORBIDDEN','Only the universe owner or a world admin/editor can manage residents');
    return row;
  }
  function capabilities(roomId,userId){try{authorize(roomId,userId);return{canManage:true};}catch{return{canManage:false};}}
  function rowFor(roomId,id){const row=store.get('SELECT * FROM room_bots WHERE id=? AND room_id=? AND deleted_at IS NULL',id,roomId);if(!row)v.fail(404,'BOT_NOT_FOUND','Resident is unavailable');return row;}
  function humans(roomId,row){return[...presence.values()].filter(p=>p.roomId===roomId&&p.kind!=='bot'&&p.userId&&now()-p.lastSeen<60000&&store.user(p.userId)&&store.canSeeRoom(row,p.userId));}
  function publicBot(r){return{id:r.id,botId:r.id,kind:'bot',roomId:r.roomId,name:r.config.name,appearance:clone(r.config.appearance),x:r.x,z:r.z,moving:r.moving,heading:r.heading,direction:r.direction,status:r.status,revision:r.revision,providerStatus:'unconnected'};}
  function snapshot(roomId){return[...runtime.values()].filter(r=>r.roomId===roomId).map(publicBot);}
  function publish(roomId){const bots=snapshot(roomId),encoded=JSON.stringify(bots);if(lastPublished.get(roomId)!==encoded){lastPublished.set(roomId,encoded);emitRoom(roomId,'bots',{roomId,bots});}}
  function stop(r,status){r.path=[];r.moving=false;r.status=status;}
  function reset(r,config,revision,sceneRevision){r.config=config;r.revision=revision;r.sceneRevision=sceneRevision;r.waypoint=0;r.pauseUntil=0;r.command=null;r.routeDone=false;r.blockedUntil=0;r.failures=0;stop(r,'returning');r.target=null;}
  function reconcileRoom(roomId,{publishChange=true}={}){
    if(closed||!roomId)return;
    let room;try{room=store.roomRow(roomId);}catch{}
    const active=room&&!room.archived_at&&!room.world_archived&&!room.universe_archived&&humans(roomId,room).length>0;
    const rows=active?store.all('SELECT * FROM room_bots WHERE room_id=? AND deleted_at IS NULL',roomId):[],ids=new Set();
    for(const row of rows){const config=JSON.parse(row.config);if(!config.enabled)continue;ids.add(row.id);let r=runtime.get(row.id);
      if(!r){r={id:row.id,roomId,x:config.spawn.x,z:config.spawn.z,heading:0,direction:0,moving:false};reset(r,config,row.revision,room.revision);runtime.set(row.id,r);}
      else if(r.revision!==row.revision){
        const movementKeys=['spawn','radius','behavior','waypoints','speed','pauseMs','loop','restrictedAreaIds'];
        if(movementKeys.some(key=>JSON.stringify(r.config[key])!==JSON.stringify(config[key])))reset(r,config,row.revision,room.revision);
        else {r.config=config;r.revision=row.revision;}
      }
      if(r.sceneRevision!==room.revision){r.sceneRevision=room.revision;r.path=[];r.target=null;r.blockedUntil=0;r.failures=0;r.moving=false;}
    }
    for(const[id,r]of runtime)if(r.roomId===roomId&&!ids.has(id))runtime.delete(id);
    if(publishChange)publish(roomId);
  }
  function travel(r,scene,target,dt,returning){
    const mode=returning?'returning':'patrol';
    if(distance(r,target)<.025){if(!segmentClear(r,target,navigationPolicy(scene,r.config,{returnFrom:returning?r:null}))){stop(r,'blocked');return false;}r.x=target.x;r.z=target.z;stop(r,mode);r.target=null;return true;}
    if(r.blockedUntil>now()){r.status='blocked';r.moving=false;return false;}
    if(!r.path.length||!r.target||distance(r.target,target)>.001){
      r.target={...target};r.path=planBotPath(scene,r,target,r.config,{returning});
      if(r.path===null){r.path=[];r.failures++;r.blockedUntil=now()+Math.min(30000,1000*2**Math.min(5,r.failures));stop(r,'blocked');return false;}
    }
    const allowed=navigationPolicy(scene,r.config,{returnFrom:returning?r:null});let budget=r.config.speed*dt;r.moving=false;r.status=mode;
    while(budget>0&&r.path.length){const next=r.path[0],length=distance(r,next);if(length<.00001){r.path.shift();continue;}
      const step=Math.min(length,budget),p={x:r.x+(next.x-r.x)*step/length,z:r.z+(next.z-r.z)*step/length};
      if(!segmentClear(r,p,allowed)){stop(r,'blocked');r.target=null;r.blockedUntil=now()+1000;return false;}
      const dx=p.x-r.x,dz=p.z-r.z;r.heading=Math.atan2(dx,dz);r.direction=Math.abs(dx)>Math.abs(dz)?dx>0?2:1:dz>0?0:3;r.x=p.x;r.z=p.z;r.moving=true;budget-=step;
      if(step>=length-1e-7)r.path.shift();
    }
    if(!r.path.length){r.target=null;r.failures=0;return distance(r,target)<.025;}return false;
  }
  function advance(r,scene,dt,players){
    const c=r.config;r.moving=false;
    const spatial=navigationPolicy(scene,c,{returnFrom:r});
    if(!spatial(r)){stop(r,'blocked');return;}
    if(r.command==='pause'){stop(r,'paused');return;}
    if(r.command==='return'||distance(r,c.spawn)>c.radius+1e-6||c.behavior!=='patrol'||r.status==='returning'){
      if(travel(r,scene,c.spawn,dt,true)){if(r.command==='return'){r.command='pause';stop(r,'paused');return;}r.status=c.behavior==='social'?'social-unconnected':'idle';}
      else return;
    }
    if(c.behavior!=='patrol'){stop(r,c.behavior==='social'?'social-unconnected':'idle');return;}
    if(r.routeDone){stop(r,'idle');return;}
    if(r.pauseUntil>now()){
      // A real moving visitor can shorten a pause; no fabricated conversation,
      // media bubble, greeting or quest partner is created without a provider.
      if(!players.some(p=>p.moving&&distance(r,p)<=c.responseRadius)){r.status='paused';return;}r.pauseUntil=0;
    }
    const target=c.waypoints[r.waypoint];if(!target){stop(r,'blocked');return;}
    if(travel(r,scene,target,dt,false)){
      r.waypoint++;if(r.waypoint>=c.waypoints.length){if(c.loop)r.waypoint=0;else r.routeDone=true;}
      r.pauseUntil=now()+c.pauseMs;r.status=c.pauseMs?'paused':'patrol';
    }
  }
  function tick(){
    if(closed)return;const t=now(),dt=Math.max(0,Math.min(.25,(t-lastTick)/1000));lastTick=t;
    const rooms=new Set([...presence.values()].map(p=>p.roomId).concat([...runtime.values()].map(r=>r.roomId)));
    for(const roomId of rooms){reconcileRoom(roomId,{publishChange:false});let room;try{room=store.roomRow(roomId);}catch{continue;}const scene=roomScene(room),players=humans(roomId,room);
      for(const r of runtime.values())if(r.roomId===roomId)advance(r,scene,dt,players);publish(roomId);
    }
  }
  const timer=autoTick?setInterval(tick,100):null;timer?.unref();
  function reauth(req,userId,roomId){if(session){const current=session(req);if(current?.user_id!==userId)v.fail(401,'AUTH_REQUIRED','Sign in again');}return authorize(roomId,userId);}
  function operation(userId,b,payload,action){
    const operationId=v.id(b.clientOperationId,'clientOperationId'),hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const old=store.get('SELECT * FROM bot_operations WHERE user_id=? AND operation_id=?',userId,operationId);
    if(old){if(old.payload_hash!==hash)v.fail(409,'OPERATION_REUSED','Use a new operation ID for a different change');return{...JSON.parse(old.result),duplicate:true};}
    const result=action();store.run('INSERT INTO bot_operations(user_id,operation_id,payload_hash,result,created_at) VALUES(?,?,?,?,?)',userId,operationId,hash,JSON.stringify(result),now());return result;
  }
  // Both the HTTP controls and model tools pass through this exact command receipt authority.
  function prepareCommand(roomId,id,userId,b){
    const row=rowFor(roomId,id),config=JSON.parse(row.config);
    if(!config.permissions[b.command])v.fail(403,'BOT_TOOL_DISABLED','This local ability is disabled for this resident');
    if(!config.enabled)v.fail(409,'BOT_DISABLED','Enable this resident before using movement controls');
    reconcileRoom(roomId,{publishChange:false});if(!runtime.has(id))v.fail(409,'BOT_INACTIVE','A person must be in the room before the resident can move');
    const key=`${userId}:${id}`,rate=commandRates.get(key),t=now();if(rate&&t-rate.start<10000&&rate.count>=20)v.fail(429,'BOT_COMMAND_LIMIT','Wait a moment before another command');
    commandRates.set(key,!rate||t-rate.start>=10000?{start:t,count:1}:{start:rate.start,count:rate.count+1});
    return{accepted:true,id,command:b.command,providerStatus:'unconnected'};
  }
  function applyCommand(effect){
    const r=runtime.get(effect.id);if(!r)v.fail(409,'BOT_INACTIVE','The resident is no longer active');
    r.command=effect.command==='resume'?null:effect.command;r.blockedUntil=0;r.path=[];r.target=null;r.pauseUntil=0;if(r.routeDone||r.waypoint>=r.config.waypoints.length)r.waypoint=0;r.routeDone=false;stop(r,r.command==='pause'?'paused':r.command==='return'?'returning':'idle');
  }
  function command({userId,roomId,id,clientOperationId,command,guard=()=>{}}){
    if(closed)v.fail(503,'BOT_CLOSED');v.oneOf(command,TOOLS,'command');v.id(clientOperationId,'clientOperationId');let effect=null;
    const result=store.transaction(()=>{guard();authorize(roomId,userId);return operation(userId,{clientOperationId},{roomId,id,action:'command',command},()=>{const result=prepareCommand(roomId,id,userId,{command});effect={id,command};return result;});});
    // COMMIT acknowledgement precedes the runtime movement effect. A replay never reapplies it.
    guard();if(effect)applyCommand(effect);tick();publish(roomId);return result;
  }
  function catalog(){return{residentTest:residentTest(),appearances:clone(AVATAR_PRESETS),behaviors:[{id:'idle',name:'Stay at home'},{id:'patrol',name:'Patrol an ordered route'},{id:'social',name:'Social · AI provider unconnected; remains silent'}],tools:TOOLS.map(id=>({id,name:{pause:'Pause movement',resume:'Resume configured behavior',return:'Return home and pause'}[id],scope:'This resident in this room',implementation:'local-server',requires:'universe owner or world admin/editor'})),provider:{status:'unconnected',message:residentTest().available?'Private manager tests use a configured local test provider. Residents remain silent in the room.':'No AI provider or external MCP server is connected. Private instructions are stored for managers only and are not executed.'},limits:{maxBots:MAX_ROOM_BOTS,maxWaypoints:64}};}
  async function handle({req,res,path,method,userId}){
    const permissionPath=path.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/bot-permissions$/);
    if(permissionPath){store.authorize(permissionPath[1],userId);if(method!=='GET')v.fail(405,'METHOD_NOT_ALLOWED');send(res,200,capabilities(permissionPath[1],userId));return true;}
    const match=path.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/bots(?:\/([A-Za-z0-9_-]+))?(?:\/(commands))?$/);if(!match)return false;
    const[,roomId,id,action]=match;authorize(roomId,userId);
    if(method==='GET'&&!action){const data=id?{bot:record(rowFor(roomId,id))}:{bots:store.all('SELECT * FROM room_bots WHERE room_id=? AND deleted_at IS NULL ORDER BY created_at,id',roomId).map(record),capabilities:{canManage:true},catalog:catalog()};send(res,200,data);return true;}
    if(!((method==='POST'&&!id)||(method==='PATCH'&&id&&!action)||(method==='DELETE'&&id&&!action)||(method==='POST'&&id&&action==='commands')))v.fail(405,'METHOD_NOT_ALLOWED');
    const b=await body(req);let commandEffect=null;
    const result=store.transaction(()=>{
      const room=reauth(req,userId,roomId);let payload;
      if(method==='POST'&&!id){strict(b,['clientOperationId','config']);payload={roomId,action:'create',config:b.config};}
      else if(method==='PATCH'){strict(b,['clientOperationId','revision','patch']);v.integer(b.revision,'revision');payload={roomId,id,action:'update',revision:b.revision,patch:b.patch};}
      else if(method==='DELETE'){strict(b,['clientOperationId','revision']);v.integer(b.revision,'revision');payload={roomId,id,action:'delete',revision:b.revision};}
      else {strict(b,['clientOperationId','command']);v.oneOf(b.command,TOOLS,'command');payload={roomId,id,action:'command',command:b.command};}
      return operation(userId,b,payload,()=>{
        if(method==='POST'&&!id){
          if(store.get('SELECT COUNT(*) AS n FROM room_bots WHERE room_id=? AND deleted_at IS NULL',roomId).n>=MAX_ROOM_BOTS)v.fail(409,'BOT_LIMIT','This room has reached its resident limit');
          const config=validateBotConfig(b.config,roomScene(room)),botId=`bot-${randomUUID()}`;
          store.run('INSERT INTO room_bots(id,room_id,config,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)',botId,roomId,JSON.stringify(config),userId,now(),now());return{bot:record(rowFor(roomId,botId))};
        }
        const row=rowFor(roomId,id);
        if(action==='commands'){
          const result=prepareCommand(roomId,id,userId,b);commandEffect={id,command:b.command};return result;
        }
        if(row.revision!==b.revision)v.fail(409,'BOT_REVISION_CONFLICT','This resident changed. Reload and review your draft before saving.',{bot:record(row)});
        if(method==='DELETE'){store.run('UPDATE room_bots SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?',now(),now(),id);return{deleted:true,id};}
        const config=validateBotConfig(b.patch,roomScene(room),JSON.parse(row.config));
        store.run('UPDATE room_bots SET config=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',JSON.stringify(config),now(),id,b.revision);return{bot:record(rowFor(roomId,id))};
      });
    });
    reconcileRoom(roomId,{publishChange:false});
    if(commandEffect)applyCommand(commandEffect);
    if(id&&(method==='PATCH'||method==='DELETE')&&!result.duplicate)onChanged(roomId,id);
    tick();publish(roomId);send(res,method==='POST'&&!id&&!result.duplicate?201:200,result);return true;
  }
  return{handle,command,snapshot,reconcileRoom,tick,capabilities,close(){closed=true;if(timer)clearInterval(timer);runtime.clear();lastPublished.clear();commandRates.clear();}};
}
