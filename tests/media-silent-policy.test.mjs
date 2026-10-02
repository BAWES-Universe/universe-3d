// Deterministic server-policy tests. No device or external provider is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaPolicy} from '../server/media.mjs';
import {SILENT_MEDIA_MESSAGE} from '../src/media-policy-copy.js';
const area=(id,action,x=0,z=0,width=4,depth=4)=>({id,name:id,action,x,z,width,depth,meetingName:'shared'});
function fixture({role='member',areas=[area('meeting','meeting',0,0,10,10),area('quiet','silent',0,0,2,2)]}={}){
 const presence=new Map(['a','b'].map((userId,index)=>[`r:${userId}`,{userId,name:userId,roomId:'r',x:2+index,z:0,status:'online',moving:false,lastSeen:100}]));
 const store={room:()=>({scene:{areas},role}),roomRow:()=>({}),canSeeRoom:()=>true,authorize:()=>({role})},events=[];
 const media=createMediaPolicy({store,presence,emitUser:(userId,event,data)=>events.push({userId,event,data}),now:()=>100});
 media.state('a','r',true);media.state('b','r',true);return{media,events,presence,move(userId,x,z){Object.assign(presence.get(`r:${userId}`),{x,z});media.refresh('r');}};
}
test('Silent keeps opt-in but removes sending/receiving graph and denies all signal forms in both directions',()=>{
 const f=fixture();assert.equal(f.media.policy('a','r').peers.length,1);f.move('a',0,0);const p=f.media.policy('a','r');assert.equal(p.enabled,true);assert.equal(p.context.kind,'silent');assert.equal(p.context.reason,SILENT_MEDIA_MESSAGE);assert.equal(p.context.canPublish,false);assert.deepEqual(p.peers,[]);assert.deepEqual(f.media.policy('b','r').peers,[]);
 for(const [sender,to]of [['a','b'],['b','a']])for(const payload of [{request:'offer'},{candidate:{candidate:'controlled'}},{description:{type:'offer',sdp:'v=0\r\n'}},{description:{type:'answer',sdp:'v=0\r\n'}}])assert.throws(()=>f.media.signal(sender,'r',{roomId:'r',to,connectionId:'fixture',...payload}),error=>error.code==='MEDIA_FORBIDDEN');
 f.move('a',2,0);assert.equal(f.media.policy('a','r').peers.length,1);
});
test('Silent is highest-priority context across every room role and media area overlap',()=>{
 for(const role of ['owner','admin','editor','moderator','member','guest'])for(const action of ['meeting','stage','audience'])for(const reverse of [false,true]){
  const areas=[area('base',action),area('quiet','silent')];const f=fixture({role,areas:reverse?areas.reverse():areas});f.move('a',0,0);const p=f.media.policy('a','r');assert.equal(p.context.kind,'silent',`${role}/${action}/${reverse}`);assert.deepEqual(p.peers,[]);
 }
});
test('Single-process refresh emits current synchronous snapshots; policy payload has no revision or session binding',()=>{
 const f=fixture();f.events.length=0;f.move('a',0,0);f.move('a',2,0);const events=f.events.filter(event=>event.userId==='a');assert.deepEqual(events.map(event=>event.data.context.kind),['silent','meeting']);assert(events.every(event=>event.data.selfId==='a'&&event.data.roomId==='r'));assert(events.every(event=>!('revision'in event.data)&&!('sessionId'in event.data)));
});
test('Busy blocks proximity only, and remains allowed in a meeting when not in Silent',()=>{
 for(const areas of [[],[area('meeting','meeting',0,0,10,10)]]){const f=fixture({areas});f.presence.get('r:a').status='busy';const p=f.media.policy('a','r');assert.equal(p.context.kind,areas.length?'meeting':'proximity');assert.equal(p.context.canPublish,!!areas.length);assert.equal(p.peers.length,areas.length?1:0);}
});
