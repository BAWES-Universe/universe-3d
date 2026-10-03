// Actual SQLite authority with synchronous host/SSE callbacks. No delayed writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {createMediaPolicy} from '../server/media.mjs';
import {createProximityText} from '../server/proximity-text.mjs';
import {proximityFixture} from './fixtures/proximity-config.mjs';
const scene={version:1,theme:'garden',bounds:{width:100,depth:100},spawn:{x:0,z:0},objects:[],areas:[]};
const seeds=[{id:'world',name:'World',rooms:['r','other'].map(id=>({id,name:id,scene}))}];
function fixture(t){
 let at=1800000000000,hook=()=>{};const store=new Store(':memory:',seeds,()=>at),presence=new Map(),connections=new Map(),events=[];
 const media=createMediaPolicy({store,presence,now:()=>at,emitUser(){},proximityMembershipConfig:proximityFixture});
 const text=createProximityText({store,media,connections,now:()=>at,sse(res,event,data){const entry={res,event,data};events.push(entry);hook(entry);}});
 t.after(()=>{text.close();media.close();store.close();});
 function add(roomId='r',account){
  const user=account??store.createUser('Member','0'),session={token_hash:randomUUID(),user_id:user.id,current_room_id:roomId,expires_at:at+1000000};
  store.run('INSERT INTO sessions VALUES(?,?,?,?)',session.token_hash,user.id,session.expires_at,roomId);
  if(roomId)presence.set(`${roomId}:${user.id}`,{userId:user.id,roomId,x:0,z:0,moving:false,status:'online',lastSeen:at});
  const client={userId:user.id,res:{destroyed:false,writableEnded:false}};connections.set(session.token_hash,new Set([client]));text.register(session.token_hash,client);
  return{user,session,client};
 }
 const latest=a=>events.filter(e=>e.res===a.client.res&&e.event==='proximity-text-context').at(-1)?.data;
 const body=p=>({requestId:randomUUID(),text:'hello',...Object.fromEntries(['connectionEpoch','roomId','bubbleId','memberId','membershipRevision'].map(key=>[key,p[key]]))});
 return{store,presence,connections,media,text,events,add,latest,body,hook(fn){hook=fn;},clear(){events.length=0;},advance(ms){at+=ms;},get time(){return at;}};
}
function unavailable(p){assert.equal(p.canSend,false);assert.equal(p.reason,'authority-unavailable');assert.equal(p.roomId,null);assert.equal(p.memberId,null);assert.equal(p.bubbleId,null);assert.deepEqual(p.conversationRecipients,[]);}

test('global refresh completes each room before capturing another, including siblings and no-room contexts',t=>{
 const f=fixture(t),a=f.add(),b=f.add('other'),c=f.add(),d=f.add('other'),sibling=f.add('r',a.user),outside=f.add(null);
 const capture=f.media.captureProximityTextRoom,rooms=[];f.media.captureProximityTextRoom=id=>{rooms.push(id);return capture(id);};f.clear();f.text.refresh();
 assert.deepEqual(rooms,['r','other']);for(const member of[a,b,c,d,sibling]){assert.equal(f.latest(member).canSend,true);assert.equal(f.latest(member).roomId,member.session.current_room_id);}
 assert.deepEqual(f.latest(a).conversationRecipients,f.latest(sibling).conversationRecipients);assert.notEqual(f.latest(a).connectionEpoch,f.latest(sibling).connectionEpoch);
 assert.equal(f.latest(outside).canSend,false);assert.equal(f.latest(outside).roomId,null);assert.equal(f.latest(outside).reason,'no-active-bubble');
 f.clear();rooms.length=0;f.text.refresh('r');assert.deepEqual(rooms,['r']);assert.equal(f.latest(b),undefined);assert.equal(f.latest(d),undefined);assert.equal(f.latest(outside),undefined);
});

for(const mutation of['expiry','room','identity','acl','mute'])test(`refresh rereads each accepted session and ACL after a callback changes ${mutation}`,t=>{
 const f=fixture(t),a=f.add(),b=f.add(),sibling=f.add('r',b.user);f.text.refresh('r');const old=f.latest(b);f.clear();let changed=false;
 f.hook(e=>{if(changed||e.res!==a.client.res)return;changed=true;
  if(mutation==='expiry')f.store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?',f.time,b.session.token_hash);
  if(mutation==='room')f.store.run('UPDATE sessions SET current_room_id=? WHERE token_hash=?','other',b.session.token_hash);
  if(mutation==='identity')f.store.run('UPDATE sessions SET user_id=? WHERE token_hash=?',a.user.id,b.session.token_hash);
  if(mutation==='acl')f.store.run('INSERT INTO members(room_id,user_id,role,banned) VALUES(?,?,?,1)','r',b.user.id,'member');
  if(mutation==='mute')f.store.run('INSERT INTO members(room_id,user_id,role,muted_until) VALUES(?,?,?,?)','r',b.user.id,'member',f.time+1000);
 });
 f.text.refresh('r');assert(changed);
 if(mutation==='mute'){assert.equal(f.latest(b).canSend,false);assert.equal(f.latest(b).reason,'muted');assert.equal(f.latest(b).connectionEpoch,old.connectionEpoch);}
 else{unavailable(f.latest(b));assert.notEqual(f.latest(b).connectionEpoch,old.connectionEpoch);}
 if(!['acl','mute'].includes(mutation))assert.equal(f.latest(sibling).canSend,true);
});

test('failed room capture clears contexts without falling back to per-stream fresh policy',t=>{
 const f=fixture(t),a=f.add(),b=f.add();f.text.refresh('r');const old=f.latest(a),capture=f.media.captureProximityTextRoom;
 f.media.captureProximityTextRoom=()=>{throw Error('capture failed');};f.media.proximityTextPolicy=()=>{assert.fail('failed batch must not fall back');};f.clear();f.text.refresh('r');
 unavailable(f.latest(a));unavailable(f.latest(b));assert.notEqual(f.latest(a).connectionEpoch,old.connectionEpoch);
 f.media.captureProximityTextRoom=capture;f.text.refresh('r');assert.equal(f.latest(a).canSend,true);
});

test('another authority transaction invalidates the rest of a refresh batch',t=>{
 const f=fixture(t),a=f.add(),b=f.add(),c=f.add();f.clear();let changed=false;
 f.hook(e=>{if(!changed&&e.res===a.client.res){changed=true;f.media.proximityTextPolicy(a.session);}});f.text.refresh('r');
 assert.equal(f.latest(a).canSend,true);unavailable(f.latest(b));unavailable(f.latest(c));
});

test('clock regression inside a refresh fails closed and clears subsequent contexts',t=>{
 const f=fixture(t),a=f.add(),b=f.add(),c=f.add();f.clear();let changed=false;
 f.hook(e=>{if(!changed&&e.res===a.client.res){changed=true;f.advance(-1);}});f.text.refresh('r');unavailable(f.latest(b));unavailable(f.latest(c));
});

for(const mutation of['geometry','status','presence'])test(`nested refresh invalidates an outer metadata snapshot after ${mutation} changes`,t=>{
 const f=fixture(t),a=f.add(),b=f.add();f.clear();let changed=false;
 f.hook(e=>{if(changed||e.res!==a.client.res)return;changed=true;
  if(mutation==='geometry')f.store.run('UPDATE rooms SET scene=? WHERE id=?',JSON.stringify({...scene,areas:[{id:'quiet',action:'silent',x:0,z:0,width:10,depth:10}]}),'r');
  if(mutation==='status')f.store.run('UPDATE users SET status=? WHERE id=?','dnd',b.user.id);
  if(mutation==='presence')f.presence.get(`r:${b.user.id}`).x=20;
  f.media.refresh('r');f.text.refresh('r');
 });f.text.refresh('r');
 assert(changed);assert.equal(f.events.filter(e=>e.res===b.client.res).length,1);assert.equal(f.latest(b).canSend,false);assert.equal(f.latest(a).canSend,false);
 const revisions=f.events.map(e=>e.data.contextRevision);assert.deepEqual(revisions,[...revisions].sort((a,b)=>a-b));
});

for(const operation of['retire','register','close'])test(`reentrant ${operation} prevents an older refresh from emitting later contexts`,t=>{
 const f=fixture(t),a=f.add(),b=f.add();f.text.refresh('r');const old=f.latest(b);f.clear();let changed=false;
 f.hook(e=>{if(changed||e.res!==a.client.res)return;changed=true;
  if(operation==='retire')f.text.retire(b.session.token_hash);
  if(operation==='register')f.text.register(b.session.token_hash,b.client);
  if(operation==='close')f.text.close();
 });f.text.refresh('r');assert(changed);
 if(operation==='register'){assert.equal(f.events.filter(e=>e.res===b.client.res).length,1);assert.notEqual(f.latest(b).connectionEpoch,old.connectionEpoch);assert.equal(f.latest(b).canSend,true);}
 else assert.equal(f.latest(b),undefined);
 if(operation==='retire')assert.notEqual(b.client.proximityText.epoch,old.connectionEpoch);
});

test('refresh does not admit a stream added or removed by an SSE callback',t=>{
 const f=fixture(t),a=f.add(),b=f.add();let late;f.clear();let changed=false;
 f.hook(e=>{if(changed||e.res!==a.client.res)return;changed=true;f.connections.get(b.session.token_hash).delete(b.client);late={userId:b.user.id,res:{destroyed:false,writableEnded:false}};f.connections.get(b.session.token_hash).add(late);});
 f.text.refresh('r');assert.equal(f.latest(b),undefined);assert.equal(f.events.some(e=>e.res===late.res),false);
});

test('GET, begin and send use fresh policy even after a successful metadata refresh',t=>{
 const f=fixture(t),a=f.add(),b=f.add();let captures=0,fresh=0;const capture=f.media.captureProximityTextRoom,policy=f.media.proximityTextPolicy;
 f.media.captureProximityTextRoom=id=>{captures++;return capture(id);};f.media.proximityTextPolicy=s=>{fresh++;return policy(s);};
 f.text.refresh('r');assert.equal(captures,1);assert.equal(fresh,0);
 const p=f.text.context(a.session,a.client.proximityText.epoch);assert(fresh>0);const before=fresh,batch=f.text.begin(a.session);assert(fresh>before);
 f.store.run('UPDATE rooms SET scene=? WHERE id=?',JSON.stringify({...scene,areas:[{id:'quiet',action:'silent',x:0,z:0,width:10,depth:10}]}),'r');
 f.clear();const afterBegin=fresh;assert.throws(()=>f.text.send(a.session,f.body(p),batch),e=>e.status===403);assert(fresh>afterBegin);assert.equal(captures,1);assert.equal(f.events.some(e=>e.event==='proximity-text-message'),false);
 assert.throws(()=>f.text.begin(b.session),e=>e.status===403);
});
