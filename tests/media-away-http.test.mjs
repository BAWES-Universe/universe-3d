// Loopback API authority fixtures. No real device/permission/relay/SFU traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameServer} from '../server/app.mjs';
import {proximityFixture} from './fixtures/proximity-config.mjs';
const scene={version:1,theme:'garden',bounds:{width:100,depth:100},spawn:{x:0,z:0},objects:[],areas:[]};
async function fixture(t,optional=true){
 const app=createGameServer({database:':memory:',seeds:[{id:'world',name:'World',rooms:['r','other'].map(id=>({id,name:id,scene}))}],questsEnabled:false,...(optional?{proximityMembershipConfig:proximityFixture}:{})});
 const{port}=await app.listen(0),base=`http://127.0.0.1:${port}`;t.after(()=>app.close());
 async function add(name){let cookie='';const call=async(path,method='GET',body)=>{const r=await fetch(base+path,{method,headers:{cookie,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];assert(r.ok,`${method} ${path}: ${r.status}`);return r.json();};await call('/api/session','POST',{name,woka:0});await call('/api/rooms/r/join','POST',{});return {call,policy:()=>call('/api/media'),async consent(enabled=true){const p=await call('/api/media');return call('/api/media/state','POST',{enabled,roomId:'r',...(p.proximityMembership?.memberId?{memberId:p.proximityMembership.memberId}:{})});}};}
 return {app,add,setAreas(areas){app.store.run('UPDATE rooms SET scene=? WHERE id=?',JSON.stringify({...scene,areas}),'r');}};
}
test('all-member projection retains a conversation with every microphone opted out and SFU transport unavailable',async t=>{
 const f=await fixture(t),people=[];for(let i=0;i<6;i++)people.push(await f.add(`Member ${i}`));const p=await people[0].policy();assert.equal(p.enabled,false);assert.deepEqual(p.peers,[]);assert.equal(p.proximityMembership.transport.blockedReason,'sfu-unavailable');assert.equal(p.proximityMembership.transport.connectedTransport,null);assert.deepEqual(p.awayPrivacy,{protocol:'media-away-v1',source:'proximity-membership',conversationActive:true,liveSessionActive:false,liveSessionSupported:false});
 await people[0].consent();assert.equal((await people[0].policy()).awayPrivacy.conversationActive,true);
 for(const person of people.slice(1))await person.call('/api/rooms/other/join','POST',{});const alone=await people[0].policy();assert.equal(alone.proximityMembership.bubbleId,null);assert.equal(alone.awayPrivacy.conversationActive,false);assert.equal(alone.awayPrivacy.liveSessionActive,false);
});
test('legacy projection describes only the server media graph, with no unsupported all-member claim',async t=>{
 const f=await fixture(t,false),a=await f.add('A'),b=await f.add('B');const initial=await a.policy();assert.equal(initial.awayPrivacy.source,'legacy-media-graph');assert.equal(initial.awayPrivacy.conversationActive,false);await a.consent();assert.equal((await a.policy()).awayPrivacy.conversationActive,false);await b.consent();assert.equal((await a.policy()).awayPrivacy.conversationActive,true);await b.consent(false);assert.equal((await a.policy()).awayPrivacy.conversationActive,false);
});
test('stage and meeting labels, publishing permission and audio opt-in never fabricate a live session',async t=>{
 const f=await fixture(t),a=await f.add('Owner');for(const action of ['stage','meeting']){f.setAreas([{id:'zone',action,x:0,z:0,width:10,depth:10,meetingName:'room'}]);await a.consent();const p=await a.policy();assert.equal(p.context.kind,action);assert.equal(p.context.canPublish,true);assert.equal(p.enabled,true);assert.deepEqual(p.awayPrivacy,{protocol:'media-away-v1',source:'legacy-media-graph',conversationActive:false,liveSessionActive:false,liveSessionSupported:false});}
 const b=await f.add('Listener');await b.consent();assert.equal((await a.policy()).awayPrivacy.conversationActive,true);f.setAreas([{id:'silent',action:'silent',x:0,z:0,width:10,depth:10}]);const quiet=await a.policy();assert.equal(quiet.context.canPublish,false);assert.equal(quiet.awayPrivacy.conversationActive,false);
});
