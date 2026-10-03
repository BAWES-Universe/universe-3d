import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer} from '../server/app.mjs';

// Independent wire consumer: deliberately imports neither the operation helpers
// nor the editor model. Expectations derive from the published v1/v2 contract.
const copy=structuredClone;
const canon=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canon).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';
const hash=v=>createHash('sha256').update(canon(v)).digest('hex');
const context=(s,version=2)=>hash(Object.fromEntries(Object.entries(s).filter(([k])=>!(version===1?['objects','terrain']:['objects','terrain','areas','theme','bounds','spawn']).includes(k))));
const area=(id,x=-8,extra={})=>({id,name:id,action:'welcome',x,z:0,width:6,depth:6,...extra});
const desk=(id='desk',x=-8,mode='dynamic')=>area(id,x,{personalArea:{mode,allowedTags:[]}});
const object=(id,x=8,z=0,extra={})=>({id,type:'chair',name:id,x,z,rotation:0,...extra});
const scene=(areas=[],objects=[])=>({version:1,theme:'garden',bounds:{width:36,depth:30},spawn:{x:0,z:12},objects,areas});
const areaOp=(before,after)=>({kind:'area',id:(before??after).id,before:before===null?null:hash(before),after});
const objectOp=(before,after)=>({kind:'object',id:(before??after).id,before:before===null?null:hash(before),after});
const fieldOp=(s,field,after)=>({kind:'scene',field,before:Object.hasOwn(s,field)?hash(s[field]):null,after});
const cellOp=(before,after)=>({kind:'terrain',x:(before??after)[0],z:(before??after)[1],before,after});
const endpoint=r=>`/api/rooms/${r.id}/scene/operations`;
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.data;};
const revisions=r=>Object.fromEntries(r.personalAreas.map(a=>[a.areaId,a.revision]));
// Dependency preimages are built independently for this fixture vocabulary.
// These fixtures use only chairs and walls; adding another type must declare its
// real catalogue dimensions rather than silently borrowing production helpers.
function dependencies(s,ops){
 const structural=ops.some(o=>o.kind!=='scene'||o.field!=='theme');
 const result={version:1,bounds:structural?s.bounds:null,spawn:structural?s.spawn:null,areas:[],objects:[],terrain:[]};if(!structural)return hash(result);
 const target=(kind,id)=>ops.some(o=>o.kind===kind&&o.id===id),cellTarget=c=>ops.some(o=>o.kind==='terrain'&&o.x===c[0]&&o.z===c[1]);
 const rect=o=>{const dims={chair:[.7,.7],wall:[3,.3]}[o.type];assert.ok(dims,'Independent fixture needs declared dimensions for '+o.type);const w=Math.max(dims[0],o.width??dims[0]),d=Math.max(dims[1],o.depth??dims[1]),r=(o.rotation??0)*Math.PI/180;return{x:o.x,z:o.z,width:w*Math.abs(Math.cos(r))+d*Math.abs(Math.sin(r)),depth:w*Math.abs(Math.sin(r))+d*Math.abs(Math.cos(r))};};
 const cellRect=c=>({x:c[0]+.5,z:c[1]+.5,width:1,depth:1});
 const intersects=(a,b)=>Math.abs(a.x-b.x)<=(a.width+b.width)/2+1e-8&&Math.abs(a.z-b.z)<=(a.depth+b.depth)/2+1e-8;
 const group=a=>['meeting','stage','audience'].includes(a.action)?a.meetingName||a.id:null;
 const oldAndNew=(op,list)=>[list.find(x=>x.id===op.id),op.after].filter(Boolean);
 const areaRects=ops.filter(o=>o.kind==='area').flatMap(o=>oldAndNew(o,s.areas??[])),groups=areaRects.map(group).filter(x=>x!==null);
 const allRects=[...areaRects,...ops.filter(o=>o.kind==='object').flatMap(o=>oldAndNew(o,s.objects).map(rect)),...ops.filter(o=>o.kind==='terrain').map(o=>cellRect([o.x,o.z]))];
 const all=ops.some(o=>o.kind==='scene'&&['bounds','spawn'].includes(o.field));
 result.areas=(s.areas??[]).filter(a=>!target('area',a.id)&&(all||groups.includes(group(a))||allRects.some(r=>intersects(r,a))));
 result.objects=s.objects.filter(o=>!target('object',o.id)&&(all||areaRects.some(a=>intersects(a,rect(o)))));
 result.terrain=(s.terrain?.cells??[]).filter(c=>!cellTarget(c)&&(all||areaRects.some(a=>intersects(a,cellRect(c))))).sort((a,b)=>a[1]-b[1]||a[0]-b[0]);return hash(result);
}
const batch=(c,r,operations,extra={})=>({version:2,operationId:randomUUID(),baseRevision:r.revision,contextHash:context(r.scene),operations,admission:copy(c.admission),...((extra.version??2)===2?{dependenciesHash:dependencies(r.scene,operations)}:{}),...extra});
const post=(c,r,b)=>c.call(endpoint(r),'POST',b);
const current=async(c,r)=>ok(await c.call(`/api/rooms/${r.id}`)).room;
const replay=(c,r,after=0)=>c.call(endpoint(r)+`?after=${after}`);
async function enter(c,r){const data=ok(await c.call(`/api/rooms/${r.id}/join`,'POST',{}));c.admission=Object.fromEntries(['admissionId','admissionEpoch','admissionRevision'].map(k=>[k,data.arrival[k]]));return data.room;}
async function unchanged(c,r,before){const after=await current(c,r);assert.equal(after.revision,before.revision);assert.deepEqual(after.scene,before.scene);return after;}
async function denied(c,r,payload,before,statuses=[400,403,409]){const result=await post(c,r,payload);assert.ok(statuses.includes(result.status),JSON.stringify(result));await unchanged(c,r,before);return result;}
async function legacy(c,r,mutate){const before=await current(c,r),next=copy(before.scene);mutate(next);return c.call(`/api/rooms/${r.id}/scene`,'PUT',{revision:before.revision,scene:next,personalAreaRevisions:revisions(before)});}
async function fixture(t,{initial=scene(),personal=false,privateRoom=false,database=':memory:'}={}){
 const app=createGameServer({database,clock:()=>1800000000000,questsEnabled:false});const {port}=await app.listen(0);let closed=false;const close=async()=>{if(!closed){closed=true;await app.close();}};t.after(close);const base=`http://127.0.0.1:${port}`;
 function client(){return{cookie:'',async call(path,method='GET',body){const response=await fetch(base+path,{method,headers:{Cookie:this.cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});if(response.headers.get('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];return{status:response.status,data:await response.json()};}};}
 async function account(name){const c=client();c.user=ok(await c.call('/api/session','POST',{name}),201).user;if(personal)ok(await c.call('/api/account','POST',{username:'a_'+randomUUID().replaceAll('-','').slice(0,20),password:'Disposable independent local fixture password'}),201);return c;}
 const owner=await account('Owner'),editor=await account('Editor'),reader=await account('Reader');
 const world=ok(await owner.call('/api/worlds','POST',{name:'Independent area protocol',public:!privateRoom}),201).world;
 const room=ok(await owner.call('/api/rooms','POST',{worldId:world.id,name:'Areas and fields',scene:initial,public:!privateRoom}),201).room;
 if(privateRoom)ok(await owner.call(`/api/worlds/${world.id}/members/${editor.user.id}`,'PUT',{role:'member'}));
 ok(await owner.call(`/api/rooms/${room.id}/members/${editor.user.id}`,'PUT',{role:personal?'member':'editor'}));
 await enter(owner,room);await enter(editor,room);if(!privateRoom)await enter(reader,room);
 return{app,port,base,owner,editor,reader,room,world,close};
}
async function claim(c,r,id='desk'){const a=(await current(c,r)).personalAreas.find(a=>a.areaId===id);ok(await c.call('/api/presence','POST',{roomId:r.id,x:a.x,z:a.z}));return ok(await c.call(`/api/rooms/${r.id}/personal-areas/${id}/claim`,'POST',{revision:a.revision,clientOperationId:randomUUID()})).room;}
async function revoke(c,r,id='desk'){const b=await current(c,r),a=b.personalAreas.find(a=>a.areaId===id);return ok(await c.call(`/api/rooms/${r.id}/personal-areas/${id}/revoke`,'POST',{revision:a.revision,roomRevision:b.revision,objectHandling:'keep',clientOperationId:randomUUID()})).room;}
function partial(t,f,c,r,payload){let ready;const admitted=new Promise(resolve=>ready=resolve),original=f.app.store.authorize.bind(f.app.store);f.app.store.authorize=(...args)=>{const result=original(...args);if(args[1]===c.user.id)ready();return result;};t.after(()=>f.app.store.authorize=original);const encoded=JSON.stringify(payload),half=Math.floor(encoded.length/2);let req;const result=new Promise((resolve,reject)=>{req=http.request({host:'127.0.0.1',port:f.port,path:endpoint(r),method:'POST',headers:{Cookie:c.cookie,'Content-Type':'application/json','Transfer-Encoding':'chunked'}},res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(data)}));});req.on('error',reject);req.write(encoded.slice(0,half));});t.after(()=>req.destroy());return{ready:Promise.race([admitted,result.then(r=>assert.fail('Request completed before streamed mutation: '+JSON.stringify(r)))]),result,finish:()=>req.end(encoded.slice(half))};}

for(const other of ['object','terrain','area','theme'])for(const reverse of [false,true])test(`AREA-I disjoint area versus ${other}, ${reverse?'reverse':'forward'} commit order`,async t=>{
 const a=area('a'),b=area('b',8),f=await fixture(t,{initial:scene([a,b])}),base=await current(f.owner,f.room);
 const first=batch(f.owner,base,[areaOp(a,{...a,name:'Changed A'})]);
 const alternative={object:objectOp(null,object('new',8)),terrain:cellOp(null,[8,7,'stone',false]),area:areaOp(b,{...b,name:'Changed B'}),theme:fieldOp(base.scene,'theme','assembly')}[other];
 const second=batch(f.editor,base,[alternative]);for(const[c,p]of reverse?[[f.editor,second],[f.owner,first]]:[[f.owner,first],[f.editor,second]])ok(await post(c,f.room,p));
 const final=await current(f.owner,f.room);assert.equal(final.revision,2);assert.equal(final.scene.areas[0].name,'Changed A');
 if(other==='area')assert.equal(final.scene.areas[1].name,'Changed B');if(other==='object')assert.equal(final.scene.objects[0].id,'new');if(other==='terrain')assert.deepEqual(final.scene.terrain.cells,[[8,7,'stone',false]]);if(other==='theme')assert.equal(final.scene.theme,'assembly');
 const journal=ok(await replay(f.owner,f.room));assert.deepEqual(journal.snapshots.map(s=>s.revision),[1,2]);assert.deepEqual(journal.snapshots.at(-1).scene,final.scene);
});

for(const reverse of [false,true])test(`AREA-I disjoint complete scene fields merge ${reverse?'reverse':'forward'}`,async t=>{
 const f=await fixture(t),base=await current(f.owner,f.room),a=batch(f.owner,base,[fieldOp(base.scene,'theme','assembly')]),b=batch(f.editor,base,[fieldOp(base.scene,'bounds',{width:40,depth:34}),fieldOp(base.scene,'spawn',{x:0,z:13})]);
 for(const[c,p]of reverse?[[f.editor,b],[f.owner,a]]:[[f.owner,a],[f.editor,b]])ok(await post(c,f.room,p));const final=await current(f.owner,f.room);assert.deepEqual(final.scene.bounds,{width:40,depth:34});assert.deepEqual(final.scene.spawn,{x:0,z:13});assert.equal(final.scene.theme,'assembly');
});

for(const target of ['area','area-delete','area-add','theme','bounds','spawn'])test(`AREA-I stale same ${target} conflicts atomically`,async t=>{
 const a=area('a'),f=await fixture(t,{initial:scene(target==='area-add'?[]:[a])}),base=await current(f.owner,f.room);
 const op=target==='area'?areaOp(a,{...a,name:'First'}):target==='area-delete'?areaOp(a,null):target==='area-add'?areaOp(null,a):fieldOp(base.scene,target,target==='theme'?'assembly':target==='bounds'?{width:40,depth:30}:{x:0,z:11});
 const second=target.startsWith('area')?areaOp(target==='area-add'?null:a,{...a,action:'silent'}):fieldOp(base.scene,target,target==='theme'?'lounge':target==='bounds'?{width:42,depth:30}:{x:0,z:10});
 const saved=ok(await post(f.owner,f.room,batch(f.owner,base,[op]))).room;const rejected=await denied(f.editor,f.room,batch(f.editor,base,[objectOp(null,object('rollback',8)),second]),saved,[409]);assert.equal(rejected.data.code,'SCENE_OPERATION_CONFLICT');assert.ok(rejected.data.conflicts.some(c=>c.kind===(target.startsWith('area')?'area':'scene')));
});

test('AREA-I full area hash includes unknown metadata and ordered actions but not key insertion order',async t=>{
 const a=area('actions',-8,{unknown:{nested:'keep'},actions:[{id:'a',type:'message',message:'One'},{id:'b',type:'message',message:'Two'}]}),f=await fixture(t,{initial:scene([a])});let base=await current(f.owner,f.room);
 const ordered=Object.fromEntries(Object.entries(a).reverse());ok(await post(f.owner,f.room,batch(f.owner,base,[areaOp(ordered,{...a,name:'Canonical'})])));base=await current(f.owner,f.room);
 const wrong=copy(base.scene.areas[0]);wrong.actions.reverse();await denied(f.editor,f.room,batch(f.editor,base,[areaOp(wrong,{...wrong,name:'Wrong order'})]),base,[409]);
 const stale=batch(f.editor,base,[areaOp(base.scene.areas[0],{...base.scene.areas[0],name:'Stale metadata'})]);ok(await legacy(f.owner,f.room,s=>s.areas[0].unknown.nested='changed'));const saved=await current(f.owner,f.room);await denied(f.editor,f.room,stale,saved,[409]);
});

test('AREA-I update/delete/add preserve existing area order and append declaration order',async t=>{
 const a=area('a',0,{action:'meeting',meetingName:'first'}),b=area('b',0,{action:'meeting',meetingName:'second'}),f=await fixture(t,{initial:scene([a,b])}),base=await current(f.owner,f.room);
 ok(await f.reader.call('/api/presence','POST',{roomId:f.room.id,x:0,z:0}));assert.equal(ok(await f.reader.call('/api/media')).context.group,'first');
 const c=area('c',0,{action:'meeting',meetingName:'third'}),d=area('d',0,{action:'meeting',meetingName:'fourth'});
 const result=ok(await post(f.owner,f.room,batch(f.owner,base,[areaOp(b,{...b,name:'Updated second'}),areaOp(null,c),areaOp(a,null),areaOp(null,d)]))).room;
 assert.deepEqual(result.scene.areas.map(a=>a.id),['b','c','d']);assert.equal(ok(await f.reader.call('/api/media')).context.group,'second');
});

for(const reverse of [false,true])test(`AREA-I unseen overlapping area additions conflict in either save order ${reverse}`,async t=>{
 const f=await fixture(t),base=await current(f.owner,f.room),a=area('a',0,{action:'meeting',meetingName:'A'}),b=area('b',0,{action:'meeting',meetingName:'B'});
 const requests=[[f.owner,batch(f.owner,base,[areaOp(null,a)])],[f.editor,batch(f.editor,base,[areaOp(null,b)])]];if(reverse)requests.reverse();
 const saved=ok(await post(requests[0][0],f.room,requests[0][1])).room;await denied(requests[1][0],f.room,requests[1][1],saved,[409]);
 assert.deepEqual(saved.scene.areas.map(a=>a.id),reverse?['b']:['a']);ok(await f.reader.call('/api/presence','POST',{roomId:f.room.id,x:0,z:0}));assert.equal(ok(await f.reader.call('/api/media')).context.group,reverse?'B':'A');
});

for(const kind of ['old-footprint','new-footprint','moved-out','boundary','neighbor-reorder'])test(`AREA-I area dependency detects unseen ${kind} changes`,async t=>{
 const a=area('a',-8,{action:'meeting'}),b=area('b',kind==='old-footprint'||kind==='moved-out'||kind==='neighbor-reorder'?-8:kind==='boundary'?-2:8,{action:'meeting'}),c=area('c',-8,{action:'meeting'}),f=await fixture(t,{initial:scene(kind==='neighbor-reorder'?[a,b,c]:[a,b])}),base=await current(f.owner,f.room);
 const nextA={...a,name:'Stale target',...(kind==='new-footprint'?{x:8}:kind==='old-footprint'?{x:0}:{})},pending=batch(f.editor,base,[areaOp(a,nextA)]);
 if(kind==='neighbor-reorder')ok(await legacy(f.owner,f.room,s=>s.areas=[s.areas[0],s.areas[2],s.areas[1]]));else ok(await post(f.owner,f.room,batch(f.owner,base,[areaOp(b,{...b,name:'Unseen neighbor change',...(kind==='moved-out'?{x:8}:{})})])));
 await denied(f.editor,f.room,pending,await current(f.owner,f.room),[409]);
});

test('AREA-I atomic known overlapping additions are allowed and use declaration order',async t=>{
 const f=await fixture(t),base=await current(f.owner,f.room),a=area('a',0,{action:'meeting',meetingName:'A'}),b=area('b',0,{action:'meeting',meetingName:'B'});
 const saved=ok(await post(f.owner,f.room,batch(f.owner,base,[areaOp(null,b),areaOp(null,a)]))).room;assert.deepEqual(saved.scene.areas.map(a=>a.id),['b','a']);
 ok(await f.reader.call('/api/presence','POST',{roomId:f.room.id,x:0,z:0}));assert.equal(ok(await f.reader.call('/api/media')).context.group,'B');
});

test('AREA-I v1 advertisements, context fences, operation kinds and receipts remain exact',async t=>{
 const a=area('a'),f=await fixture(t,{initial:scene([a])}),base=await current(f.owner,f.room);assert.deepEqual(base.sceneOperations,{version:1});assert.deepEqual(base.sceneOperationsV2,{version:2,sceneFields:['theme','bounds','spawn']});
 const v1=batch(f.editor,base,[objectOp(null,object('v1',8))],{version:1,contextHash:context(base.scene,1)});
 const saved=ok(await post(f.owner,f.room,batch(f.owner,base,[areaOp(a,{...a,name:'V2 area'})]))).room;await denied(f.editor,f.room,v1,saved,[409]);
 const fresh=batch(f.editor,saved,[objectOp(null,object('v1',8))],{version:1,contextHash:context(saved.scene,1)});assert.equal(ok(await post(f.editor,f.room,fresh)).receipt.version,1);
 const latest=await current(f.owner,f.room);await denied(f.owner,f.room,batch(f.owner,latest,[areaOp(latest.scene.areas[0],null)],{version:1,contextHash:context(latest.scene,1)}),latest,[400]);
});

for(const change of ['unknown','scene-version'])test(`AREA-I ${change} remains a v2 global context fence`,async t=>{
 const initial=scene([area('a')]);initial.extension={theme:'unknown nested context'};const f=await fixture(t,{initial}),base=await current(f.editor,f.room),pending=batch(f.editor,base,[areaOp(base.scene.areas[0],{...base.scene.areas[0],name:'pending'})]);
 ok(await legacy(f.owner,f.room,s=>{if(change==='unknown')s.extension.theme='changed';else s.version=2;}));await denied(f.editor,f.room,pending,await current(f.owner,f.room),[409]);
});

test('AREA-I theme deletion uses absent-field preconditions and cannot delete structural fields',async t=>{
 const f=await fixture(t),base=await current(f.owner,f.room);const removed=ok(await post(f.owner,f.room,batch(f.owner,base,[fieldOp(base.scene,'theme',null)]))).room;assert.equal(Object.hasOwn(removed.scene,'theme'),false);
 const restore=ok(await post(f.owner,f.room,batch(f.owner,removed,[fieldOp(removed.scene,'theme','garden')]))).room;assert.equal(restore.scene.theme,'garden');
 for(const field of ['bounds','spawn'])await denied(f.owner,f.room,batch(f.owner,restore,[fieldOp(restore.scene,field,null)]),restore,[400]);
});

test('AREA-I malformed v2 targets, immutable IDs, envelope metadata and privilege injection fail without mutation',async t=>{
 const a=area('a'),f=await fixture(t,{initial:scene([a])}),base=await current(f.owner,f.room),valid=areaOp(a,{...a,name:'valid'});
 const invalid=[{operations:[valid,valid]},{operations:[{...valid,after:{...a,id:'other'}}]},{operations:[{...valid,before:'bad'}]},{operations:[{...valid,position:0}]},{operations:[{kind:'scene',field:'areas',before:hash([a]),after:[]}]},{operations:[{kind:'scene',field:'extension',before:null,after:'injected'}]},{operations:[{...fieldOp(base.scene,'bounds',{width:40,depth:30}),ownerId:f.editor.user.id}]},{actorId:f.editor.user.id},{ownerId:f.editor.user.id},{operations:[{kind:'area',id:'absent',before:null,after:null}]}];
 for(const key of ['ownerId','actorId','userId','claimRevision','canEditObjects','serverData'])invalid.push({operations:[areaOp(a,{...a,[key]:f.editor.user.id})]});
 invalid.push({operations:[areaOp(a,{...a,personalArea:{mode:'dynamic',allowedTags:[],ownerId:f.editor.user.id}})]});
 for(const change of invalid)await denied(f.owner,f.room,batch(f.owner,base,[valid],change),base,[400]);
});

for(const reverse of [false,true])test(`AREA-I duplicate named entry across stale area additions is rejected ${reverse}`,async t=>{
 const f=await fixture(t),base=await current(f.owner,f.room),a=area('a',-8,{start:{key:'same'}}),b=area('b',8,{start:{key:'same'}}),requests=[[f.owner,a],[f.editor,b]];if(reverse)requests.reverse();
 const saved=ok(await post(requests[0][0],f.room,batch(requests[0][0],base,[areaOp(null,requests[0][1])]))).room;
 const result=await denied(requests[1][0],f.room,batch(requests[1][0],base,[fieldOp(base.scene,'theme','assembly'),areaOp(null,requests[1][1])]),saved,[400,409]);assert.equal(result.data.code,'DUPLICATE_ENTRY');
});

test('AREA-I named entry edits jointly validate existing collider geometry',async t=>{
 const f=await fixture(t,{initial:scene([], [object('existing',8)])}),base=await current(f.owner,f.room);
 await denied(f.owner,f.room,batch(f.owner,base,[areaOp(null,area('blocked',8,{width:.9,depth:.9,start:{key:'blocked'}})),fieldOp(base.scene,'theme','assembly')]),base,[400,409]);
});

for(const kind of ['object-footprint','ordinary-area','personal-area','named-area','human','resident'])test(`AREA-I bounds-only shrink protects unchanged ${kind}`,async t=>{
 const initial=scene();if(kind==='object-footprint')initial.objects=[object('edge',7.5,0,{width:2})];if(kind.endsWith('area'))initial.areas=[area('edge',7.5,{width:2,...(kind==='personal-area'?{personalArea:{mode:'dynamic',allowedTags:[]}}:kind==='named-area'?{start:{key:'edge'}}:{})})];
 const f=await fixture(t,{initial});if(kind==='human')ok(await f.reader.call('/api/presence','POST',{roomId:f.room.id,x:9,z:0}));if(kind==='resident'){ok(await f.owner.call(`/api/rooms/${f.room.id}/bots`,'POST',{clientOperationId:randomUUID(),config:{name:'Resident',spawn:{x:9,z:0},radius:0,behavior:'idle'}}),201);assert.equal(ok(await f.owner.call(`/api/rooms/${f.room.id}`)).bots.length,1);}
 const base=await current(f.owner,f.room);await denied(f.owner,f.room,batch(f.owner,base,[fieldOp(base.scene,'bounds',{width:16,depth:30})]),base,[400,409]);
});

for(const reverse of [false,true])test(`AREA-I shrink versus stale edge object revalidates both save orders ${reverse}`,async t=>{
 const f=await fixture(t),base=await current(f.owner,f.room),requests=[[f.owner,batch(f.owner,base,[fieldOp(base.scene,'bounds',{width:16,depth:30})])],[f.editor,batch(f.editor,base,[objectOp(null,object('edge',7.5,0,{width:2}))])]];if(reverse)requests.reverse();
 const saved=ok(await post(...[requests[0][0],f.room,requests[0][1]])).room;await denied(requests[1][0],f.room,requests[1][1],saved,[400,409]);
});

test('AREA-I atomic bounds plus matching object and area moves use final combined geometry',async t=>{
 const a=area('edge',13,{width:4}),o=object('edge',13,6),f=await fixture(t,{initial:scene([a],[o])}),base=await current(f.owner,f.room);
 const saved=ok(await post(f.owner,f.room,batch(f.owner,base,[fieldOp(base.scene,'bounds',{width:20,depth:30}),objectOp(o,{...o,x:6}),areaOp(a,{...a,x:6})]))).room;
 assert.equal(saved.scene.bounds.width,20);assert.equal(saved.scene.objects[0].x,6);assert.equal(saved.scene.areas[0].x,6);
});

for(const kind of ['collider','trapped-route'])test(`AREA-I spawn-only shift rejects unchanged ${kind}`,async t=>{
 const objects=kind==='collider'?[object('solid',8)]:[{id:'north',type:'wall',x:8,z:-1,width:3,depth:.3},{id:'south',type:'wall',x:8,z:1,width:3,depth:.3},{id:'west',type:'wall',x:7,z:0,width:3,depth:.3,rotation:90},{id:'east',type:'wall',x:9,z:0,width:3,depth:.3,rotation:90}];
 const f=await fixture(t,{initial:scene([],objects)}),base=await current(f.owner,f.room);await denied(f.owner,f.room,batch(f.owner,base,[fieldOp(base.scene,'spawn',{x:8,z:0})]),base,[400,409]);
});

for(const operation of ['area','theme','bounds','spawn'])test(`AREA-I scoped personal owner cannot mutate ${operation}`,async t=>{
 const f=await fixture(t,{personal:true,initial:scene([desk()])});await claim(f.editor,f.room);const base=await current(f.editor,f.room),op=operation==='area'?areaOp(base.scene.areas[0],{...base.scene.areas[0],name:'Forged global access'}):fieldOp(base.scene,operation,operation==='theme'?'assembly':operation==='bounds'?{width:40,depth:30}:{x:0,z:11});
 await denied(f.editor,f.room,batch(f.editor,base,[objectOp(null,object('rollback',-8,-2)),op],{personalAreaRevisions:revisions(base)}),base,[403]);
});

test('AREA-I stale full editor keeps unrelated area edit across a personal claim; scoped current grant can still build',async t=>{
 const a=area('separate',8),f=await fixture(t,{personal:true,initial:scene([desk(),a])}),base=await current(f.owner,f.room),pending=batch(f.owner,base,[areaOp(a,{...a,name:'Survives claim'})]);await claim(f.editor,f.room);ok(await post(f.owner,f.room,pending));
 const latest=await current(f.editor,f.room);ok(await post(f.editor,f.room,batch(f.editor,latest,[objectOp(null,object('owned',-8,-2))],{personalAreaRevisions:revisions(latest)})));assert.equal((await current(f.editor,f.room)).personalAreas[0].ownerId,f.editor.user.id);
});

for(const change of ['claim','assign'])test(`AREA-I streamed full area write cannot overwrite concurrent ${change}`,{timeout:15000},async t=>{
 const f=await fixture(t,{personal:true,initial:scene([desk('desk',-8,change==='assign'?'static':'dynamic')])}),base=await current(f.owner,f.room),pending=partial(t,f,f.owner,f.room,batch(f.owner,base,[areaOp(base.scene.areas[0],{...base.scene.areas[0],name:'Stale name'})]));await pending.ready;
 if(change==='claim')await claim(f.editor,f.room);else ok(await f.owner.call(`/api/rooms/${f.room.id}/personal-areas/desk/assign`,'POST',{revision:base.personalAreas[0].revision,userId:f.editor.user.id,clientOperationId:randomUUID()}));
 const saved=await current(f.owner,f.room);pending.finish();const rejected=await pending.result;assert.equal(rejected.status,409,JSON.stringify(rejected));await unchanged(f.owner,f.room,saved);assert.equal(saved.personalAreas[0].ownerId,f.editor.user.id);
});

for(const change of ['revoke','tag-policy','membership'])test(`AREA-I streamed scoped object uses current ${change} authority`,{timeout:15000},async t=>{
 const f=await fixture(t,{personal:true,initial:scene([desk()])});await claim(f.editor,f.room);const base=await current(f.editor,f.room),pending=partial(t,f,f.editor,f.room,batch(f.editor,base,[objectOp(null,object('stale',-8,-2))],{personalAreaRevisions:revisions(base)}));await pending.ready;
 if(change==='revoke')await revoke(f.owner,f.room);else if(change==='tag-policy')ok(await post(f.owner,f.room,batch(f.owner,base,[areaOp(base.scene.areas[0],{...base.scene.areas[0],personalArea:{mode:'dynamic',allowedTags:['new-tag']}})])));else ok(await f.owner.call(`/api/rooms/${f.room.id}/moderate`,'POST',{action:'ban',userId:f.editor.user.id}));
 const saved=await current(f.owner,f.room);pending.finish();const rejected=await pending.result;assert.ok([403,404,409].includes(rejected.status),JSON.stringify(rejected));await unchanged(f.owner,f.room,saved);if(change==='tag-policy')assert.equal(saved.personalAreas[0].ownerId,f.editor.user.id);
});

test('AREA-I scoped edits enforce old and new ownership footprints after live area edits',async t=>{
 const f=await fixture(t,{personal:true,initial:scene([desk(),desk('other',8)])});await claim(f.editor,f.room);await claim(f.reader,f.room,'other');let base=await current(f.editor,f.room);
 const own=object('own',-8,-2);ok(await post(f.editor,f.room,batch(f.editor,base,[objectOp(null,own)],{personalAreaRevisions:revisions(base)})));ok(await legacy(f.owner,f.room,s=>s.objects.push(object('foreign',8,-2))));base=await current(f.editor,f.room);
 for(const op of [objectOp(own,{...own,x:8}),objectOp(base.scene.objects.find(o=>o.id==='foreign'),object('foreign',-6,-2))])await denied(f.editor,f.room,batch(f.editor,base,[op],{personalAreaRevisions:revisions(base)}),base,[403]);
});

test('AREA-I duplicate/lost-response area commit retains exact receipt across rejoin and later scene field writes',async t=>{
 const f=await fixture(t),base=await current(f.owner,f.room),a=area('once'),payload=batch(f.owner,base,[areaOp(null,a),fieldOp(base.scene,'theme','assembly')]);
 await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:f.port,path:endpoint(f.room),method:'POST',headers:{Cookie:f.owner.cookie,'Content-Type':'application/json'}},res=>{res.destroy();resolve();});req.on('error',reject);req.end(JSON.stringify(payload));});
 const after=await current(f.owner,f.room);assert.equal(after.revision,1);ok(await post(f.editor,f.room,batch(f.editor,after,[fieldOp(after.scene,'bounds',{width:40,depth:30})])));await enter(f.owner,f.room);
 const repeated=ok(await post(f.owner,f.room,{...payload,admission:f.owner.admission}));assert.equal(repeated.duplicate,true);assert.equal(repeated.receipt.version,2);assert.equal(repeated.receipt.appliedRevision,1);assert.equal(repeated.room.revision,2);
 const identity={roomId:f.room.id,version:2,baseRevision:payload.baseRevision,contextHash:payload.contextHash,operations:payload.operations,personalAreaRevisions:null,dependenciesHash:payload.dependenciesHash};assert.equal(repeated.receipt.requestHash,hash(identity));
 const changed=copy(payload);changed.operations[0].after.name='Another payload';await denied(f.owner,f.room,{...changed,admission:f.owner.admission},repeated.room,[409]);assert.deepEqual(ok(await replay(f.owner,f.room)).snapshots.map(s=>s.revision),[1,2]);
});

test('AREA-I area retry and replay cannot reveal private room after access downgrade',async t=>{
 const f=await fixture(t,{privateRoom:true}),base=await current(f.editor,f.room),payload=batch(f.editor,base,[areaOp(null,area('private'))]);ok(await post(f.editor,f.room,payload));
 ok(await f.owner.call(`/api/rooms/${f.room.id}/members/${f.editor.user.id}`,'DELETE'));ok(await f.owner.call(`/api/worlds/${f.world.id}/members/${f.editor.user.id}`,'DELETE'));
 for(const r of [await post(f.editor,f.room,payload),await replay(f.editor,f.room)]){assert.ok([401,403,404,409].includes(r.status),JSON.stringify(r));for(const k of ['room','receipt','snapshots'])assert.equal(r.data[k],undefined);}
});

test('AREA-I claim, v2 area, legacy PUT and revoke writers share one gap-free journal',async t=>{
 const f=await fixture(t,{personal:true,initial:scene([desk(),area('ordinary',8)])});await claim(f.editor,f.room);let base=await current(f.owner,f.room);
 ok(await post(f.owner,f.room,batch(f.owner,base,[areaOp(base.scene.areas[1],{...base.scene.areas[1],name:'V2 edit'})])));ok(await legacy(f.owner,f.room,s=>s.theme='assembly'));await revoke(f.owner,f.room);
 const final=await current(f.owner,f.room),journal=ok(await replay(f.owner,f.room));assert.equal(final.revision,4);assert.deepEqual(journal.snapshots.map(s=>s.revision),[1,2,3,4]);assert.deepEqual(journal.snapshots.at(-1).scene,final.scene);
});

for(const table of ['scene_operation_receipts','scene_operation_journal'])test(`AREA-I SQLite ${table} failure rolls back area sync and accepts identical retry once`,async t=>{
 const f=await fixture(t),base=await current(f.owner,f.room),payload=batch(f.owner,base,[areaOp(null,desk()),fieldOp(base.scene,'theme','assembly')]),beforeReplay=ok(await replay(f.owner,f.room));
 f.app.store.db.exec(`CREATE TEMP TRIGGER area_independent_abort BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Independent area commit rollback'); END`);
 const rejected=await post(f.owner,f.room,payload);f.app.store.db.exec('DROP TRIGGER area_independent_abort');assert.equal(rejected.status,500,JSON.stringify(rejected));await unchanged(f.owner,f.room,base);assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM personal_areas WHERE room_id=?',f.room.id).n,0);assert.deepEqual(ok(await replay(f.owner,f.room)),beforeReplay);
 const accepted=ok(await post(f.owner,f.room,payload));assert.equal(accepted.duplicate,false);assert.equal(accepted.receipt.version,2);assert.equal(accepted.room.revision,1);assert.equal(accepted.room.personalAreas.length,1);assert.equal(ok(await post(f.owner,f.room,payload)).duplicate,true);
});

for(const target of ['delete','geometry','mode'])test(`AREA-I full editor cannot ${target} a currently claimed personal area`,async t=>{
 const f=await fixture(t,{personal:true,initial:scene([desk()])});await claim(f.editor,f.room);const base=await current(f.owner,f.room),old=base.scene.areas[0],next=target==='delete'?null:target==='geometry'?{...old,x:-7}:{...old,personalArea:{mode:'static',allowedTags:[]}};
 const result=await denied(f.owner,f.room,batch(f.owner,base,[areaOp(old,next),fieldOp(base.scene,'theme','assembly')]),base,[409]);assert.equal(result.data.code,'PERSONAL_AREA_CLAIMED');
});

test('AREA-I scoped duplicate receipt fails after revoke and succeeds only after explicit full editing grant',async t=>{
 const f=await fixture(t,{personal:true,initial:scene([desk()])});await claim(f.editor,f.room);const base=await current(f.editor,f.room),payload=batch(f.editor,base,[objectOp(null,object('owned',-8,-2))],{personalAreaRevisions:revisions(base)}),saved=ok(await post(f.editor,f.room,payload));await revoke(f.owner,f.room);
 const before=await current(f.owner,f.room),deniedRetry=await post(f.editor,f.room,payload);assert.equal(deniedRetry.status,403,JSON.stringify(deniedRetry));assert.equal(deniedRetry.data.receipt,undefined);await unchanged(f.owner,f.room,before);
 ok(await f.owner.call(`/api/rooms/${f.room.id}/members/${f.editor.user.id}`,'PUT',{role:'editor'}));const retry=ok(await post(f.editor,f.room,payload));assert.equal(retry.duplicate,true);assert.deepEqual(retry.receipt,saved.receipt);assert.equal(retry.room.revision,before.revision);
});

test('AREA-I durable v2 request version and canonical receipt survive SQLite reopen with refreshed admission',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'scene-area-independent-'));t.after(()=>rm(directory,{recursive:true,force:true}));const database=join(directory,'world.sqlite'),f=await fixture(t,{database}),base=await current(f.owner,f.room),payload=batch(f.owner,base,[areaOp(null,area('durable')),fieldOp(base.scene,'theme','assembly')]),accepted=ok(await post(f.owner,f.room,payload));await f.close();
 const app=createGameServer({database,clock:()=>1800000000000,questsEnabled:false}),{port}=await app.listen(0);t.after(()=>app.close());const recovered={cookie:f.owner.cookie,async call(path,method='GET',body){const response=await fetch(`http://127.0.0.1:${port}`+path,{method,headers:{Cookie:this.cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,data:await response.json()};}};
 const stale=await post(recovered,f.room,payload);assert.ok([401,403,409].includes(stale.status),JSON.stringify(stale));await enter(recovered,f.room);const retry=ok(await post(recovered,f.room,{...payload,admission:recovered.admission}));assert.equal(retry.duplicate,true);assert.equal(retry.receipt.version,2);assert.deepEqual(retry.receipt,accepted.receipt);assert.deepEqual(retry.room.scene,accepted.room.scene);assert.deepEqual(ok(await replay(recovered,f.room)).snapshots.map(s=>s.revision),[1]);
});

for(const reverse of [false,true])test(`AREA-I legacy reorder remains revision CAS against v2 writes ${reverse}`,async t=>{
 const a=area('a'),b=area('b',8),f=await fixture(t,{initial:scene([a,b])}),base=await current(f.owner,f.room),ordered=copy(base.scene);ordered.areas.reverse();const operation=batch(f.editor,base,[fieldOp(base.scene,'theme','assembly')]);
 if(reverse){ok(await post(f.editor,f.room,operation));const latest=await current(f.owner,f.room),result=await f.owner.call(`/api/rooms/${f.room.id}/scene`,'PUT',{revision:base.revision,scene:ordered});assert.equal(result.status,409,JSON.stringify(result));await unchanged(f.owner,f.room,latest);}
 else{ok(await f.owner.call(`/api/rooms/${f.room.id}/scene`,'PUT',{revision:base.revision,scene:ordered}));const result=ok(await post(f.editor,f.room,operation));assert.deepEqual(result.room.scene.areas.map(a=>a.id),['b','a']);assert.equal(result.room.scene.theme,'assembly');}
});

for(const target of ['object','terrain'])for(const reverse of [false,true])test(`AREA-I overlapping area versus ${target} has symmetric dependency conflict ${reverse}`,async t=>{
 const a=area('meeting',8,{action:'meeting',meetingName:'old'}),f=await fixture(t,{initial:scene([a])}),base=await current(f.owner,f.room),other=target==='object'?objectOp(null,object('inside',8)):cellOp(null,[8,0,'wood',false]);
 const requests=[[f.owner,batch(f.owner,base,[areaOp(a,{...a,meetingName:'new'})])],[f.editor,batch(f.editor,base,[other])]];if(reverse)requests.reverse();
 const saved=ok(await post(requests[0][0],f.room,requests[0][1])).room;await denied(requests[1][0],f.room,requests[1][1],saved,[409]);
 const reviewed=batch(requests[1][0],saved,requests[1][1].operations);const final=ok(await post(requests[1][0],f.room,reviewed)).room;assert.equal(final.revision,2);assert.equal(final.scene.areas[0].meetingName,'new');
});

for(const reverse of [false,true])test(`AREA-I moved-away area versus object update depends on old footprint ${reverse}`,async t=>{
 const a=area('moving',8,{action:'meeting'}),o=object('inside',8),f=await fixture(t,{initial:scene([a],[o])}),base=await current(f.owner,f.room),requests=[[f.owner,batch(f.owner,base,[areaOp(a,{...a,x:0})])],[f.editor,batch(f.editor,base,[objectOp(o,{...o,name:'Changed object'})])]];if(reverse)requests.reverse();
 const saved=ok(await post(requests[0][0],f.room,requests[0][1])).room;await denied(requests[1][0],f.room,requests[1][1],saved,[409]);
});

test('AREA-I world-tag removal during scoped save retains the separately granted ownership right',{timeout:15000},async t=>{
 const d=desk();d.personalArea.allowedTags=['artist'];const f=await fixture(t,{personal:true,initial:scene([d])});ok(await f.owner.call(`/api/worlds/${f.world.id}/members/${f.editor.user.id}`,'PUT',{role:'member',tags:['artist']}));await claim(f.editor,f.room);
 const base=await current(f.editor,f.room),pending=partial(t,f,f.editor,f.room,batch(f.editor,base,[objectOp(null,object('retained-right',-8,-2))],{personalAreaRevisions:revisions(base)}));await pending.ready;
 ok(await f.owner.call(`/api/worlds/${f.world.id}/members/${f.editor.user.id}`,'PUT',{role:'member',tags:[]}));pending.finish();const result=ok(await pending.result);assert.equal(result.room.personalAreas[0].ownerId,f.editor.user.id);assert.equal(result.room.scene.objects[0].id,'retained-right');
});

for(const version of [1,2])test(`AREA-I v${version} preserves absent optional areas and theme on object-only commits`,async t=>{
 const initial=scene();delete initial.areas;delete initial.theme;const f=await fixture(t,{initial}),base=await current(f.owner,f.room);
 const requests=[[f.owner,object('one',-8)],[f.editor,object('two',8)]].map(([c,o])=>[c,batch(c,base,[objectOp(null,o)],{version,contextHash:context(base.scene,version)})]);
 for(const[c,p]of requests)ok(await post(c,f.room,p));const final=await current(f.owner,f.room);assert.equal(final.revision,2);assert.equal(Object.hasOwn(final.scene,'areas'),false);assert.equal(Object.hasOwn(final.scene,'theme'),false);assert.deepEqual(final.scene.objects.map(o=>o.id),['one','two']);
});

test('AREA-I area and field no-ops and repeated scene fields cannot create revisions or receipts',async t=>{
 const a=area('a'),f=await fixture(t,{initial:scene([a])}),base=await current(f.owner,f.room);
 for(const ops of [[areaOp(a,copy(a))],[fieldOp(base.scene,'theme',base.scene.theme)],[fieldOp(base.scene,'bounds',copy(base.scene.bounds))],[fieldOp(base.scene,'theme','assembly'),fieldOp(base.scene,'theme','lounge')]])await denied(f.owner,f.room,batch(f.owner,base,ops),base,[400]);
 assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM scene_operation_receipts WHERE room_id=?',f.room.id).n,0);
});

test('AREA-I required dependency hash cannot be omitted, forged, or added to v1',async t=>{
 const f=await fixture(t),base=await current(f.owner,f.room),ops=[areaOp(null,area('new'))],valid=batch(f.owner,base,ops),missing=copy(valid);delete missing.dependenciesHash;
 await denied(f.owner,f.room,missing,base,[400]);await denied(f.owner,f.room,{...valid,dependenciesHash:'wrong'},base,[400]);const forged=await denied(f.owner,f.room,{...valid,dependenciesHash:'0'.repeat(64)},base,[409]);assert.ok(forged.data.conflicts.some(c=>c.kind==='dependencies'));
 await denied(f.owner,f.room,batch(f.owner,base,[objectOp(null,object('v1',8))],{version:1,contextHash:context(base.scene,1),dependenciesHash:valid.dependenciesHash}),base,[400]);
 const accepted=ok(await post(f.owner,f.room,valid));const reused=await denied(f.owner,f.room,{...valid,dependenciesHash:'0'.repeat(64)},accepted.room,[409]);assert.equal(reused.data.code,'OPERATION_REUSED');
});

for(const reverse of [false,true])test(`AREA-I distant linked media groups conflict symmetrically ${reverse}`,async t=>{
 const a=area('stage',-8,{action:'stage',meetingName:'shared'}),b=area('audience',8,{action:'audience',meetingName:'shared'}),f=await fixture(t,{initial:scene([a,b])}),base=await current(f.owner,f.room),requests=[[f.owner,batch(f.owner,base,[areaOp(a,{...a,meetingName:'separate'})])],[f.editor,batch(f.editor,base,[areaOp(b,{...b,name:'Edited audience'})])]];if(reverse)requests.reverse();
 const saved=ok(await post(requests[0][0],f.room,requests[0][1])).room;await denied(requests[1][0],f.room,requests[1][1],saved,[409]);
});

test('AREA-I selecting a new trapped spawn cannot inherit a different grandfathered bad route',async t=>{
 const cage=x=>[{id:'north'+x,type:'wall',x,z:-1,width:3,depth:.3},{id:'south'+x,type:'wall',x,z:1,width:3,depth:.3},{id:'west'+x,type:'wall',x:x-1,z:0,width:3,depth:.3,rotation:90},{id:'east'+x,type:'wall',x:x+1,z:0,width:3,depth:.3,rotation:90}];
 const initial=scene([],[...cage(0),...cage(8)]);initial.spawn={x:0,z:0};const f=await fixture(t,{initial}),base=await current(f.owner,f.room);
 await denied(f.owner,f.room,batch(f.owner,base,[fieldOp(base.scene,'spawn',{x:8,z:0})]),base,[400,409]);
 const harmless=ok(await post(f.owner,f.room,batch(f.owner,base,[fieldOp(base.scene,'theme','assembly')]))).room;assert.deepEqual(harmless.scene.spawn,{x:0,z:0});
 const recovered=ok(await post(f.owner,f.room,batch(f.owner,harmless,[fieldOp(harmless.scene,'spawn',{x:0,z:12})]))).room;assert.deepEqual(recovered.scene.spawn,{x:0,z:12});
});

test('AREA-I changed spawn cannot land on existing water despite a legacy blocked original spawn',async t=>{
 const initial=scene();initial.terrain={version:1,cells:[[0,0,'water',true],[8,0,'water',true]]};const f=await fixture(t,{initial});
 // Model a pre-existing legacy record directly: current create/save validation
 // correctly forbids creating blocked spawn points through the current API.
 initial.spawn={x:.5,z:.5};f.app.store.run('UPDATE rooms SET scene=? WHERE id=?',JSON.stringify(initial),f.room.id);
 const base=await current(f.owner,f.room),rejected=await denied(f.owner,f.room,batch(f.owner,base,[fieldOp(base.scene,'spawn',{x:8.5,z:.5})]),base,[400,409]);assert.equal(rejected.data.code,'TERRAIN_BLOCKS_ARRIVAL');
});

test('AREA-I public room editor downgrade reveals current snapshot only, never deleted area history or old receipt',async t=>{
 const f=await fixture(t),base=await current(f.editor,f.room),secret=area('private-history',-8,{message:'Historical area content must not escape downgrade'}),payload=batch(f.editor,base,[areaOp(null,secret)]);ok(await post(f.editor,f.room,payload));
 const latest=await current(f.owner,f.room);ok(await post(f.owner,f.room,batch(f.owner,latest,[areaOp(secret,null)])));ok(await f.owner.call(`/api/rooms/${f.room.id}/members/${f.editor.user.id}`,'PUT',{role:'member'}));
 const journal=ok(await replay(f.editor,f.room));assert.equal(journal.mode,'snapshot');assert.deepEqual(journal.snapshots.map(s=>s.revision),[2]);assert.equal(JSON.stringify(journal).includes(secret.message),false);assert.deepEqual(journal.snapshots[0].scene.areas,[]);
 const retry=await post(f.editor,f.room,payload);assert.equal(retry.status,403,JSON.stringify(retry));assert.equal(retry.data.receipt,undefined);assert.equal(retry.data.room,undefined);
});
