import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameServer} from '../server/app.mjs';
const seeds=[{id:'bot-world',name:'Resident test world',rooms:[{id:'bot-room',name:'Resident room',scene:{version:1,bounds:{width:20,depth:20},spawn:{x:0,z:0},objects:[],areas:[]}}]}];
async function fixture(){
 const app=createGameServer({seeds}),{port}=await app.listen(0),base=`http://127.0.0.1:${port}`;
 const client=()=>({cookie:'',async call(path,method='GET',body,headers={}){const response=await fetch(base+path,{method,headers:{Cookie:this.cookie,...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});if(response.headers.get('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];return{status:response.status,data:await response.json()};}});
 const owner=client(),visitor=client();owner.user=(await owner.call('/api/session','POST',{name:'Resident owner',woka:0})).data.user;visitor.user=(await visitor.call('/api/session','POST',{name:'Human visitor',woka:1})).data.user;
 return{app,base,client,owner,visitor};
}
const path='/api/rooms/bot-room';

test('integrated cookie API keeps resident management and public bot rendering separate from human identity/media/quests',async t=>{
 const f=await fixture();t.after(()=>f.app.close());
 assert.equal((await f.client().call(path+'/bot-permissions')).status,401);
 assert.deepEqual((await f.owner.call(path+'/bot-permissions')).data,{canManage:true});assert.deepEqual((await f.visitor.call(path+'/bot-permissions')).data,{canManage:false});
 const create={clientOperationId:'integration-create',config:{name:'Original resident',radius:6,privateInstructions:'MANAGER_PRIVATE_SENTINEL',behavior:'patrol',waypoints:[{x:3,z:0}],pauseMs:0}};
 const made=await f.owner.call(path+'/bots','POST',create);assert.equal(made.status,201,JSON.stringify(made.data));const id=made.data.bot.id;
 assert.equal((await f.owner.call(path)).data.bots.length,0,'Empty room has no running bot');
 const joined=await f.visitor.call(path+'/join','POST',{});assert.equal(joined.status,200);assert.equal(joined.data.bots.length,1);assert.equal(joined.data.bots[0].id,id);assert.equal(joined.data.bots[0].kind,'bot');assert.deepEqual(joined.data.botPermissions,{canManage:false});
 assert.equal(JSON.stringify(joined.data).includes('MANAGER_PRIVATE_SENTINEL'),false);assert.equal(joined.data.presence.some(p=>p.id===id),false);assert.equal(joined.data.members.some(p=>p.id===id),false);
 assert.equal((await f.visitor.call(path+'/bots')).status,403);assert.equal((await f.visitor.call(path+'/bots/'+id)).status,403);assert.equal(f.app.store.user(id),undefined);assert.equal([...f.app.presence.values()].some(p=>p.id===id),false);
 assert.equal((await f.visitor.call('/api/users')).data.users.some(p=>p.id===id),false);
 for(const endpoint of ['/api/media','/api/quests','/api/conversations'])assert.equal(JSON.stringify((await f.visitor.call(endpoint)).data).includes(id),false,endpoint);
 assert.equal((await f.visitor.call(`/api/dm/${id}/messages`,'POST',{text:'Do not become a synthetic person'})).status,404);
 assert.equal((await f.owner.call(path+'/bots','POST',create,{'origin':'https://untrusted.invalid'})).status,403);
 const stream=await fetch(f.base+'/api/events',{headers:{Cookie:f.visitor.cookie},signal:AbortSignal.timeout(3000)}),reader=stream.body.getReader();let bytes='';
 try{while(!bytes.includes('event: bots')){const chunk=await reader.read();if(chunk.done)break;bytes+=new TextDecoder().decode(chunk.value);}}finally{await reader.cancel();}
 assert.ok(bytes.includes('event: bots'));assert.ok(bytes.includes(id));assert.equal(bytes.includes('MANAGER_PRIVATE_SENTINEL'),false);
 assert.equal((await f.owner.call(path+'/bots/'+id+'/commands','POST',{clientOperationId:'integration-pause',command:'pause'})).status,200);
 const paused=(await f.visitor.call(path)).data.bots[0];assert.equal(paused.status,'paused');
 const disabled=await f.owner.call(path+'/bots/'+id,'PATCH',{clientOperationId:'integration-disable',revision:0,patch:{enabled:false}});assert.equal(disabled.status,200);assert.deepEqual((await f.visitor.call(path)).data.bots,[]);assert.equal((await f.owner.call(path+'/bots')).data.bots[0].enabled,false);
});

test('integrated current world role revocation blocks a former editor even with a cached bot revision',async t=>{
 const f=await fixture();t.after(()=>f.app.close());
 f.app.store.run("INSERT INTO world_members(world_id,user_id,role,created_at) VALUES('bot-world',?,'editor',?)",f.visitor.user.id,Date.now());
 const made=await f.visitor.call(path+'/bots','POST',{clientOperationId:'world-editor-create',config:{name:'Editor resident'}});assert.equal(made.status,201);
 f.app.store.run("DELETE FROM world_members WHERE world_id='bot-world' AND user_id=?",f.visitor.user.id);
 f.app.store.run("INSERT INTO members(room_id,user_id,role,granted) VALUES('bot-room',?,'editor',1)",f.visitor.user.id);
 assert.deepEqual((await f.visitor.call(path+'/bot-permissions')).data,{canManage:false});
 assert.equal((await f.visitor.call(path+'/bots/'+made.data.bot.id,'PATCH',{clientOperationId:'revoked-edit',revision:0,patch:{name:'Unauthorized'}})).status,403);
 assert.equal((await f.visitor.call(path+'/bots/'+made.data.bot.id+'/commands','POST',{clientOperationId:'revoked-command',command:'pause'})).status,403);
 assert.equal((await f.owner.call(path+'/bots/'+made.data.bot.id)).data.bot.name,'Editor resident');
});
