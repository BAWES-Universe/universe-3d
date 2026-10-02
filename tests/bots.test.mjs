import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {createBotService,validateBotConfig} from '../server/bots.mjs';
import {navigationPolicy,planBotPath,segmentClear,distance} from '../server/bot-navigation.mjs';
import {AVATAR_PRESETS} from '../src/avatar-spec.js';
const scene=()=>({version:1,bounds:{width:24,depth:24},spawn:{x:0,z:0},objects:[],areas:[]});
const seed=()=>[{id:'w',name:'World',rooms:[{id:'room',name:'Room',scene:scene()},{id:'other',name:'Other',scene:scene()}]}];
const cfg=(patch={})=>({name:'Ada resident',spawn:{x:0,z:0},radius:8,...patch});
async function fixture({database=':memory:',onBody=null}={}){
 let time=1000;const now=()=>time,store=new Store(database,seed(),now),presence=new Map(),events=[];
 const users=['Owner','Member','Editor','Legacy','OtherEditor'].map(name=>store.createUser(name,'0')),[owner,member,editor,legacy,outsider]=users;
 store.run("INSERT INTO world_members(world_id,user_id,role,created_at) VALUES('w',?,'editor',?)",editor.id,now());
 store.run("INSERT INTO members(room_id,user_id,role,granted) VALUES('room',?,'editor',1)",legacy.id);
 store.run("INSERT INTO worlds(id,name,owner_id,universe_id,slug,created_at) VALUES('foreign','Foreign',?,'universe-main','foreign',?)",owner.id,now());
 store.run("INSERT INTO world_members(world_id,user_id,role,created_at) VALUES('foreign',?,'editor',?)",outsider.id,now());
 const session=req=>{const userId=req.headers['x-test-user'];if(!userId||!store.user(userId))throw Object.assign(new Error('Required'),{status:401,code:'AUTH_REQUIRED'});return{user_id:userId};};
 const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
 const bots=createBotService({store,presence,session,now,autoTick:false,send,emitRoom:(...e)=>events.push(e),body:async req=>{let text='';for await(const c of req)text+=c;const data=JSON.parse(text);onBody?.({store,users,data});return data;}});
 const server=http.createServer(async(req,res)=>{try{const s=session(req);if(!await bots.handle({req,res,path:new URL(req.url,'http://localhost').pathname,method:req.method,userId:s.user_id}))send(res,404,{});}catch(e){send(res,e.status??500,{code:e.code,message:e.message,...e.details});}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 async function call(user,path='',method='GET',data){const res=await fetch(base+'/api/rooms/room/bots'+path,{method,headers:{'x-test-user':user?.id??'','content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return{status:res.status,data:await res.json()};}
 let op=0;const create=(user=owner,patch={})=>call(user,'','POST',{clientOperationId:`create-${++op}`,config:cfg(patch)});
 function occupy(user=member,roomId='room',fields={}){presence.set(`${roomId}:${user.id}`,{userId:user.id,id:user.id,roomId,x:0,z:0,lastSeen:now(),...fields});bots.reconcileRoom(roomId);}
 function tick(ms=100){time+=ms;for(const p of presence.values())p.lastSeen=time;bots.tick();}
 const close=async()=>{bots.close();await new Promise(resolve=>server.close(resolve));store.close();};
 return{store,presence,events,bots,users,owner,member,editor,legacy,outsider,call,create,occupy,tick,now,close};
}

test('BOT-01/02 authoring requires universe owner or world admin/editor, never legacy room grant or cross-world role',async t=>{
 const f=await fixture();t.after(f.close);
 for(const user of[f.member,f.legacy,f.outsider]){assert.equal((await f.call(user)).status,403);assert.equal((await f.create(user)).status,403);}
 assert.equal((await f.call(null)).status,401);
 for(const user of[f.owner,f.editor])assert.equal((await f.create(user)).status,201);
 const list=await f.call(f.owner);assert.equal(list.data.bots.length,2);assert.equal(list.data.catalog.appearances.length,AVATAR_PRESETS.length);assert.equal(list.data.catalog.provider.status,'unconnected');
 assert.equal(f.bots.capabilities('room',f.legacy.id).canManage,false);
});

test('BOT-02 create/update/delete retries are idempotent and CAS cannot resurrect deleted configuration',async t=>{
 const f=await fixture();t.after(f.close);const body={clientOperationId:'same-create',config:cfg()};
 const a=await f.call(f.owner,'','POST',body),b=await f.call(f.owner,'','POST',body);assert.equal(b.status,200);assert.equal(a.data.bot.id,b.data.bot.id);assert.equal(b.data.duplicate,true);
 assert.equal((await f.call(f.owner,'','POST',{...body,config:cfg({name:'Changed'})})).status,409);
 const id=a.data.bot.id,edit={clientOperationId:'edit-one',revision:0,patch:{name:'New name'}};
 const updated=await f.call(f.editor,'/'+id,'PATCH',edit);assert.equal(updated.status,200);assert.equal(updated.data.bot.radius,8);assert.equal(updated.data.bot.revision,1);
 assert.equal((await f.call(f.editor,'/'+id,'PATCH',edit)).data.duplicate,true);
 assert.equal((await f.call(f.owner,'/'+id,'PATCH',{...edit,clientOperationId:'stale'})).data.code,'BOT_REVISION_CONFLICT');
 const deletion={clientOperationId:'delete-one',revision:1};assert.equal((await f.call(f.owner,'/'+id,'DELETE',deletion)).status,200);assert.equal((await f.call(f.owner,'/'+id,'DELETE',deletion)).data.duplicate,true);
 assert.equal((await f.call(f.owner,'/'+id,'PATCH',{clientOperationId:'revive',revision:2,patch:{enabled:true}})).status,404);
 assert.equal((await f.call(f.owner,'','POST',body)).data.duplicate,true);assert.equal((await f.call(f.owner)).data.bots.length,0);
});

test('BOT-02 body-stream permission revocation wins before write and before replay',async t=>{
 let revoke=false;const f=await fixture({onBody:({store,users})=>{if(revoke)store.run("DELETE FROM world_members WHERE world_id='w' AND user_id=?",users[2].id);}});t.after(f.close);
 const body={clientOperationId:'revoke-test',config:cfg()};assert.equal((await f.call(f.editor,'','POST',body)).status,201);revoke=true;
 assert.equal((await f.call(f.editor,'','POST',body)).status,403);assert.equal(f.store.get('SELECT COUNT(*) n FROM room_bots').n,1);
});

test('BOT-01/25 guessed IDs, credential fields and foreign wardrobe fail without disclosing config',async t=>{
 const f=await fixture();t.after(f.close);const made=await f.create(f.owner,{privateInstructions:'MANAGER ONLY never public'}),id=made.data.bot.id;
 assert.equal((await f.call(f.member,'/'+id)).status,403);
 const req={clientOperationId:'wrongroom',revision:0,patch:{name:'wrong'}};const direct=await new Promise(resolve=>{const res={writeHead(status){this.status=status;},end(data){resolve({status:this.status,data:JSON.parse(data)});}};f.bots.handle({req:{headers:{'x-test-user':f.owner.id}},res,path:`/api/rooms/other/bots/${id}`,method:'GET',userId:f.owner.id}).catch(e=>resolve({status:e.status}));});assert.equal(direct.status,404);
 for(const patch of[{providerKey:'secret'},{roomId:'other'},{appearance:{version:1,catalog:'foreign'}}])assert.equal((await f.create(f.owner,patch)).status,400);
 f.occupy();const publicText=JSON.stringify(f.bots.snapshot('room'));assert.equal(publicText.includes('MANAGER ONLY'),false);for(const key of['privateInstructions','permissions','waypoints','createdBy'])assert.equal(publicText.includes(key),false);
 assert.equal(f.presence.size,1);assert.equal(f.store.user(id),undefined);assert.equal(f.store.members('room').some(u=>u.id===id),false);
});

test('BOT-03/04 validates spawn, radius and ordered route while preserving route order and appearance',async t=>{
 const f=await fixture();t.after(f.close);
 for(const patch of[{radius:-1},{spawn:{x:100,z:0}},{behavior:'patrol',waypoints:[]},{behavior:'patrol',waypoints:[{x:9,z:0}]}])assert.equal((await f.create(f.owner,patch)).status,400);
 const waypoints=[{x:2,z:0},{x:2,z:3},{x:0,z:3}],appearance=AVATAR_PRESETS[2].appearance;
 const r=await f.create(f.owner,{behavior:'patrol',waypoints,appearance});assert.equal(r.status,201);assert.deepEqual(r.data.bot.waypoints,waypoints);assert.deepEqual(r.data.bot.appearance,appearance);
 const moved=[waypoints[2],{x:-1,z:2},waypoints[0]];const edited=await f.call(f.owner,'/'+r.data.bot.id,'PATCH',{clientOperationId:'route-edit',revision:0,patch:{waypoints:moved}});assert.deepEqual(edited.data.bot.waypoints,moved);assert.deepEqual(edited.data.bot.appearance,appearance);
});

test('BOT-06 first human occupancy spawns once, partial leave retains, empty removes, disabled catalog survives',async t=>{
 const f=await fixture();t.after(f.close);const a=await f.create(),b=await f.create(f.owner,{name:'Disabled',enabled:false});assert.equal(f.bots.snapshot('room').length,0);
 f.occupy();f.occupy(f.editor);for(let i=0;i<10;i++)f.bots.reconcileRoom('room');assert.equal(f.bots.snapshot('room').length,1);assert.equal(f.bots.snapshot('room')[0].id,a.data.bot.id);
 f.presence.delete(`room:${f.member.id}`);f.bots.reconcileRoom('room');assert.equal(f.bots.snapshot('room').length,1);
 f.presence.clear();f.bots.reconcileRoom('room');assert.equal(f.bots.snapshot('room').length,0);f.occupy();assert.equal(f.bots.snapshot('room').length,1);
 assert.equal((await f.call(f.owner)).data.bots.length,2);assert.equal(b.data.bot.enabled,false);
 await f.call(f.owner,'/'+a.data.bot.id,'PATCH',{clientOperationId:'disable',revision:0,patch:{enabled:false}});assert.equal(f.bots.snapshot('room').length,0);
});

test('BOT-07 zero-radius idle and no-provider social remain stationary and silent',async t=>{
 const f=await fixture();t.after(f.close);await f.create(f.owner,{radius:0});await f.create(f.owner,{name:'Silent social',behavior:'social',spawn:{x:1,z:0}});f.occupy();
 for(let i=0;i<30;i++)f.tick();const bots=f.bots.snapshot('room');assert.equal(bots[0].x,0);assert.equal(bots[0].z,0);assert.equal(bots[0].moving,false);assert.equal(bots[1].status,'social-unconnected');assert.equal(bots[1].x,1);assert.equal(f.events.some(([,name])=>['message','media-policy','quest'].includes(name)),false);
});

test('BOT-09 patrol ordered travel, pause, nonloop completion and local return/pause/resume',async t=>{
 const f=await fixture();t.after(f.close);const made=await f.create(f.owner,{behavior:'patrol',waypoints:[{x:1,z:0},{x:1,z:1}],speed:2,pauseMs:300,loop:false}),id=made.data.bot.id;f.occupy();
 const positions=[];for(let i=0;i<25;i++){f.tick();positions.push(f.bots.snapshot('room')[0]);}
 assert.ok(positions.some(p=>p.x>=.99&&p.z<.01));assert.ok(positions.some(p=>p.status==='paused'));assert.ok(distance(positions.at(-1),{x:1,z:1})<.001);assert.equal(positions.at(-1).status,'idle');
 const command=(command,op)=>f.call(f.owner,'/'+id+'/commands','POST',{command,clientOperationId:op});assert.equal((await command('return','go-home')).status,200);
 for(let i=0;i<15;i++)f.tick();assert.equal(f.bots.snapshot('room')[0].status,'paused');assert.ok(distance(f.bots.snapshot('room')[0],{x:0,z:0})<.001);
 await command('resume','resume');f.tick();assert.ok(f.bots.snapshot('room')[0].moving);await command('pause','pause');const paused=f.bots.snapshot('room')[0];for(let i=0;i<5;i++)f.tick();assert.equal(f.bots.snapshot('room')[0].x,paused.x);
 assert.equal((await command('pause','pause')).data.duplicate,true);assert.equal((await f.call(f.member,'/'+id+'/commands','POST',{command:'resume',clientOperationId:'forged'})).status,403);
 await f.call(f.owner,'/'+id,'PATCH',{clientOperationId:'mask',revision:0,patch:{permissions:{pause:true,resume:true,return:false}}});assert.equal((await command('return','denied')).data.code,'BOT_TOOL_DISABLED');
});

test('BOT-09/11 revision changes cancel obsolete route and disabling stops movement immediately',async t=>{
 const f=await fixture();t.after(f.close);const a=await f.create(f.owner,{behavior:'patrol',waypoints:[{x:6,z:0}],pauseMs:0}),id=a.data.bot.id;f.occupy();for(let i=0;i<8;i++)f.tick();const before=f.bots.snapshot('room')[0];assert.ok(before.x>0);
 await f.call(f.owner,'/'+id,'PATCH',{clientOperationId:'replan',revision:0,patch:{waypoints:[{x:0,z:3}]}});for(let i=0;i<40;i++)f.tick();const after=f.bots.snapshot('room')[0];assert.ok(after.z>2);assert.ok(after.x<.05);
 await f.call(f.owner,'/'+id,'PATCH',{clientOperationId:'stop',revision:1,patch:{enabled:false}});f.tick();assert.equal(f.bots.snapshot('room').length,0);
});

test('BOT-13 path around wall is collision-safe and smoothed segments cannot cut blocked corners',()=>{
 const s=scene();s.objects=[{id:'wall',type:'wall',x:0,z:0,width:1,depth:6}];const c=validateBotConfig(cfg({spawn:{x:-4,z:0},radius:12}),s),start=c.spawn,end={x:4,z:0};const path=planBotPath(s,start,end,c);assert.ok(path?.length>1);
 const allowed=navigationPolicy(s,c);let previous=start;for(const p of path){assert.ok(segmentClear(previous,p,allowed));previous=p;}assert.deepEqual(path.at(-1),end);
 s.objects[0].depth=24;assert.equal(planBotPath(s,start,end,c),null);
});

test('BOT-11 assigned radius and deny-only restricted areas prevent forbidden movement',()=>{
 const s=scene();s.areas=[{id:'restricted',name:'Restricted',x:0,z:0,width:2,depth:8}];const c=validateBotConfig(cfg({spawn:{x:-4,z:0},radius:12,restrictedAreaIds:['restricted']}),s),allowed=navigationPolicy(s,c);
 assert.equal(allowed({x:0,z:0}),false);const path=planBotPath(s,c.spawn,{x:4,z:0},c);assert.ok(path);let p=c.spawn;for(const next of path){assert.ok(segmentClear(p,next,allowed));p=next;}
 assert.throws(()=>validateBotConfig(cfg({spawn:{x:0,z:0},restrictedAreaIds:['restricted']}),s),{code:'BOT_SPAWN_BLOCKED'});
 s.areas[0].personalArea={mode:'dynamic',allowedTags:[]};assert.equal(navigationPolicy(s,{...c,restrictedAreaIds:[]})({x:0,z:0}),false);
 assert.equal(planBotPath(s,c.spawn,{x:11,z:0},c),null);
});

test('BOT-13 live obstacle revision blocks instead of teleporting and removal replans',async t=>{
 const f=await fixture();t.after(f.close);await f.create(f.owner,{spawn:{x:-4,z:0},radius:12,behavior:'patrol',waypoints:[{x:4,z:0}],pauseMs:0});f.occupy();f.tick();
 const blocked=scene();blocked.objects=[{id:'wall',type:'wall',x:0,z:0,width:1,depth:24}];f.store.run('UPDATE rooms SET scene=?,revision=revision+1 WHERE id=?',JSON.stringify(blocked),'room');
 for(let i=0;i<60;i++)f.tick();const b=f.bots.snapshot('room')[0];assert.equal(b.status,'blocked');assert.ok(b.x<-.8);
 f.store.run('UPDATE rooms SET scene=?,revision=revision+1 WHERE id=?',JSON.stringify(scene()),'room');for(let i=0;i<80;i++)f.tick();assert.ok(f.bots.snapshot('room')[0].x>3);
});

test('BOT-02 restart restores immutable config, disabled state and operation receipts; runtime occupancy stays ephemeral',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'universe-bots-'));t.after(()=>rm(dir,{recursive:true,force:true}));const db=join(dir,'state.db');const f=await fixture({database:db});const body={clientOperationId:'persist-create',config:cfg({enabled:false,privateInstructions:'Persist manager-only',waypoints:[{x:2,z:1}]})};const made=await f.call(f.owner,'','POST',body),ownerId=f.owner.id;await f.close();
 const store=new Store(db,seed(),()=>1000),bots=createBotService({store,presence:new Map(),autoTick:false});t.after(()=>{bots.close();store.close();});const row=store.get('SELECT * FROM room_bots WHERE id=?',made.data.bot.id);assert.equal(row.revision,0);assert.equal(JSON.parse(row.config).enabled,false);assert.equal(JSON.parse(row.config).privateInstructions,'Persist manager-only');assert.equal(store.get('SELECT COUNT(*) n FROM bot_operations WHERE user_id=?',ownerId).n,1);assert.deepEqual(bots.snapshot('room'),[]);
});

test('BOT-25 public SSE allowlist excludes manager instructions even after edits',async t=>{
 const f=await fixture();t.after(f.close);const made=await f.create(f.owner,{privateInstructions:'PRIVATE_SENTINEL',permissions:{pause:false,resume:true,return:true}});f.occupy();f.tick();
 await f.call(f.owner,'/'+made.data.bot.id,'PATCH',{clientOperationId:'private-edit',revision:0,patch:{privateInstructions:'NEW_PRIVATE_SENTINEL'}});
 const serialized=JSON.stringify(f.events);assert.equal(serialized.includes('PRIVATE_SENTINEL'),false);assert.equal(serialized.includes('privateInstructions'),false);assert.equal(serialized.includes('permissions'),false);
 for(const[,name,data]of f.events){assert.equal(name,'bots');for(const bot of data.bots)assert.deepEqual(Object.keys(bot).sort(),['appearance','botId','direction','heading','id','kind','moving','name','providerStatus','revision','roomId','status','x','z'].sort());}
});

test('BOT-02 display-only edits preserve runtime path progress and pause command',async t=>{
 const f=await fixture();t.after(f.close);const made=await f.create(f.owner,{behavior:'patrol',waypoints:[{x:6,z:0}],pauseMs:0}),id=made.data.bot.id;f.occupy();for(let i=0;i<15;i++)f.tick();const before=f.bots.snapshot('room')[0].x;
 await f.call(f.owner,'/'+id,'PATCH',{clientOperationId:'rename',revision:0,patch:{name:'Renamed'}});f.tick();assert.ok(f.bots.snapshot('room')[0].x>before);
 await f.call(f.owner,'/'+id+'/commands','POST',{clientOperationId:'hold',command:'pause'});await f.call(f.owner,'/'+id,'PATCH',{clientOperationId:'wardrobe',revision:1,patch:{appearance:AVATAR_PRESETS[1].appearance}});f.tick();assert.equal(f.bots.snapshot('room')[0].status,'paused');
});

test('BOT-54 local tool protocol rejects forged identity/location, repeat receipts never reexecute, disable allowed after geometry change',async t=>{
 const f=await fixture();t.after(f.close);const made=await f.create(),id=made.data.bot.id;f.occupy();
 for(const extra of[{actorId:f.owner.id},{playerId:f.member.id},{x:5},{roomId:'other'},{tool:'external_mcp'}])assert.equal((await f.call(f.owner,'/'+id+'/commands','POST',{clientOperationId:'forged-'+Object.keys(extra)[0],command:'pause',...extra})).status,400);
 await f.call(f.owner,'/'+id+'/commands','POST',{clientOperationId:'old-pause',command:'pause'});await f.call(f.owner,'/'+id+'/commands','POST',{clientOperationId:'later-resume',command:'resume'});await f.call(f.owner,'/'+id+'/commands','POST',{clientOperationId:'old-pause',command:'pause'});f.tick();assert.equal(f.bots.snapshot('room')[0].status,'idle');
 const s=scene();s.objects=[{id:'wall',type:'wall',x:0,z:0,width:2,depth:2}];f.store.run('UPDATE rooms SET scene=?,revision=revision+1 WHERE id=?',JSON.stringify(s),'room');f.tick();assert.equal(f.bots.snapshot('room')[0].status,'blocked');
 assert.equal((await f.call(f.owner,'/'+id,'PATCH',{clientOperationId:'disable-blocked',revision:0,patch:{enabled:false}})).status,200);assert.deepEqual(f.bots.snapshot('room'),[]);
});

test('room-authorized viewers can inspect exact bot capability without private catalog access',async t=>{
 const f=await fixture();t.after(f.close);
 for(const user of[f.owner,f.editor,f.member,f.legacy,f.outsider]){
  let received;const res={};await f.bots.handle({req:{headers:{'x-test-user':user.id}},res:{writeHead(status){this.status=status;},end(data){received={status:this.status,data:JSON.parse(data)};}},path:'/api/rooms/room/bot-permissions',method:'GET',userId:user.id});
  assert.equal(received.status,200);assert.deepEqual(received.data,{canManage:[f.owner,f.editor].includes(user)});
 }
 f.store.run("UPDATE rooms SET public=0 WHERE id='other'");
 await assert.rejects(f.bots.handle({req:{},res:{},path:'/api/rooms/other/bot-permissions',method:'GET',userId:f.member.id}),{status:404});
});

test('world admin can manage bots but a room ban or archived ancestor removes that authority',async t=>{
 const f=await fixture();t.after(f.close);f.store.run("INSERT INTO world_members(world_id,user_id,role,created_at) VALUES('w',?,'admin',?)",f.member.id,f.now());
 assert.equal((await f.create(f.member)).status,201);f.store.run("INSERT INTO members(room_id,user_id,role,granted,banned) VALUES('room',?,'member',1,1)",f.member.id);
 assert.equal((await f.call(f.member)).status,404);f.store.run("UPDATE worlds SET archived_at=? WHERE id='w'",f.now());assert.equal((await f.call(f.owner)).status,404);f.occupy(f.owner);assert.deepEqual(f.bots.snapshot('room'),[]);
});

test('rotated native footprints and work-budget exhaustion never become direct fallback travel',()=>{
 const s=scene();s.objects=[{id:'diagonal-wall',type:'wall',x:0,z:0,width:.5,depth:6,rotation:45}];const c=validateBotConfig(cfg({spawn:{x:-5,z:0},radius:12}),s),allowed=navigationPolicy(s,c);
 assert.equal(allowed({x:1.5,z:0}),false);const path=planBotPath(s,c.spawn,{x:4,z:0},c);assert.ok(path?.length>1);let previous=c.spawn;for(const p of path){assert.ok(segmentClear(previous,p,allowed));previous=p;}
 assert.equal(planBotPath(s,c.spawn,{x:4,z:0},c,{maxNodes:1}),null);
});

test('assigned home edits return without teleporting and newly restricted geometry halts prior path',async t=>{
 const f=await fixture();t.after(f.close);const created=await f.create(f.owner,{behavior:'patrol',waypoints:[{x:6,z:0}],speed:1,pauseMs:0}),id=created.data.bot.id;f.occupy();for(let i=0;i<20;i++)f.tick();const before=f.bots.snapshot('room')[0];assert.ok(before.x>1);
 await f.call(f.owner,'/'+id,'PATCH',{clientOperationId:'new-home',revision:0,patch:{spawn:{x:-3,z:0},radius:1,behavior:'idle',waypoints:[]}});
 const edited=f.bots.snapshot('room')[0];assert.equal(edited.x,before.x);f.tick();assert.ok(f.bots.snapshot('room')[0].x<before.x);assert.ok(f.bots.snapshot('room')[0].x>-3);
 const s=scene();s.areas=[{id:'private-zone',name:'Private',x:0,z:0,width:1,depth:24,personalArea:{mode:'dynamic',allowedTags:['staff']}}];f.store.run('UPDATE rooms SET scene=?,revision=revision+1 WHERE id=?',JSON.stringify(s),'room');for(let i=0;i<30;i++)f.tick();assert.equal(f.bots.snapshot('room')[0].status,'blocked');assert.ok(f.bots.snapshot('room')[0].x>.8);
});
