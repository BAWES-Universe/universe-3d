// Actual SQLite authority with synchronous host/SSE callbacks. No delayed writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {createMediaPolicy} from '../server/media.mjs';
import {createProximityText} from '../server/proximity-text.mjs';
import {createProximityTyping,PROXIMITY_TYPING_LIMITS} from '../server/proximity-typing.mjs';
import {proximityFixture} from './fixtures/proximity-config.mjs';
const scene={version:1,theme:'garden',bounds:{width:100,depth:100},spawn:{x:0,z:0},objects:[],areas:[]};
const seeds=[{id:'world',name:'World',rooms:['r','other'].map(id=>({id,name:id,scene}))}];
function fixture(t){
 let at=1800000000000,hook=()=>{},timerId=0;const timers=new Map(),timerHistory=[];const typingTimers={setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,at:at+delay});timerHistory.push(fn);return id;},clearTimeout(id){timers.delete(id);}};const store=new Store(':memory:',seeds,()=>at),presence=new Map(),connections=new Map(),events=[];
 const media=createMediaPolicy({store,presence,now:()=>at,emitUser(){},proximityMembershipConfig:proximityFixture});
 const text=createProximityText({store,media,connections,typingTimers,now:()=>at,sse(res,event,data){const entry={res,event,data};events.push(entry);hook(entry);}});
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
 return{store,presence,connections,media,text,events,timers,timerHistory,add,latest,body,hook(fn){hook=fn;},clear(){events.length=0;},advance(ms){at+=ms;for(const[id,timer]of [...timers])if(timer.at<=at){timers.delete(id);timer.fn();}},get time(){return at;}};
}
const typingBody=(p,sequence=1,isTyping=true)=>({...Object.fromEntries(['connectionEpoch','roomId','bubbleId','memberId','membershipRevision'].map(key=>[key,p[key]])),sequence,isTyping});
function start(f,a,sequence=1){const p=f.text.context(a.session,a.client.proximityText.epoch);return f.text.typing.update(a.session,typingBody(p,sequence),f.text.typing.begin(a.session));}
const typing=(f,a)=>f.events.filter(e=>e.event==='proximity-typing'&&(!a||e.res===a.client.res));

test('active typing cleanup preserves room metadata batching and flushes after the outermost refresh',t=>{
 const f=fixture(t),a=f.add(),b=f.add(),c=f.add();start(f,a);f.clear();f.store.run('INSERT INTO members(room_id,user_id,role,muted_until) VALUES(?,?,?,?)','r',a.user.id,'member',f.time+10000);
 let fresh=0;const policy=f.media.proximityTextPolicy;f.media.proximityTextPolicy=s=>{fresh++;return policy(s);};f.text.refresh('r');
 const contexts=f.events.filter(e=>e.event==='proximity-text-context');assert.equal(contexts.length,3);assert.equal(contexts.every(e=>e.data.reason!=='authority-unavailable'),true);assert.equal(typing(f).length,2);assert(typing(f).every(e=>!e.data.isTyping));assert.equal(f.timers.size,0);
 assert(f.events.indexOf(typing(f)[0])>f.events.indexOf(contexts.at(-1)));assert.equal(fresh,2,'only authorized stop recipients use fresh policy after batching');
});

for(const mutation of['target-close','target-epoch','target-ban','source-mute','source-close','authority-error'])test(`typing write rechecks ${mutation} after the target context emission`,t=>{
 const f=fixture(t),a=f.add(),b=f.add(),c=f.add();f.clear();let changed=false;
 f.hook(e=>{if(changed||e.event!=='proximity-text-context'||e.res!==b.client.res)return;changed=true;
   if(mutation==='target-close'){b.client.res.destroyed=true;f.connections.get(b.session.token_hash).delete(b.client);f.text.disconnect(b.client);}
   if(mutation==='target-epoch')f.text.retire(b.session.token_hash);
   if(mutation==='target-ban')f.store.run('INSERT INTO members(room_id,user_id,role,banned) VALUES(?,?,?,1)','r',b.user.id,'member');
   if(mutation==='source-mute')f.store.run('INSERT INTO members(room_id,user_id,role,muted_until) VALUES(?,?,?,?)','r',a.user.id,'member',f.time+10000);
   if(mutation==='source-close'){a.client.res.destroyed=true;f.connections.get(a.session.token_hash).delete(a.client);f.text.disconnect(a.client);}
   if(mutation==='authority-error')f.media.proximityTextPolicy=()=>{throw Error('unavailable');};
 });
 try{start(f,a);}catch(error){assert([403,404,409,503].includes(error.status));}assert(changed);assert.equal(typing(f,b).length,0);if(mutation==='target-ban')assert.equal(f.timers.size,0);
 if(mutation.startsWith('source')||mutation==='authority-error')assert.equal(typing(f,c).length,0);
});

test('nested retire and refresh cannot flush an old contribution to a new recipient stay',t=>{
 const f=fixture(t),a=f.add(),b=f.add(),c=f.add();start(f,a);f.clear();let changed=false;
 f.hook(e=>{if(changed||e.event!=='proximity-text-context'||e.res!==a.client.res)return;changed=true;f.text.retire(a.session.token_hash);f.text.retire(b.session.token_hash);f.text.refresh('r');});
 f.text.refresh('r');assert(changed);assert.equal(typing(f,b).length,0);assert.equal(typing(f,c).length,1);assert.equal(typing(f,c)[0].data.isTyping,false);assert.equal(f.timers.size,0);
});

test('source leave while a sibling preserves membership emits only the departing stream stop',t=>{
 const f=fixture(t),a=f.add(),b=f.add(),sibling=f.add('r',a.user);start(f,a);start(f,sibling);const before=typing(f,b);assert.equal(before.length,2);const sourceId=before[0].data.sourceId;f.clear();
 f.store.run('UPDATE sessions SET current_room_id=NULL WHERE token_hash=?',a.session.token_hash);f.text.retire(a.session.token_hash);f.text.refresh('r');
 assert.equal(typing(f,b).length,1);assert.equal(typing(f,b)[0].data.sourceId,sourceId);assert.equal(typing(f,b)[0].data.isTyping,false);assert.equal(f.timers.size,1);
});

test('session expiry and lost presence fail closed before the 15s host heartbeat',t=>{
 const f=fixture(t),a=f.add(),b=f.add(),sibling=f.add('r',a.user);f.store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?',f.time+3000,a.session.token_hash);start(f,a);f.clear();f.advance(2999);assert.equal(typing(f,b).length,0);f.advance(1);assert.equal(typing(f,b).length,1);assert.equal(typing(f,b)[0].data.isTyping,false);assert.equal(f.timers.size,0);
 start(f,sibling);f.presence.delete(`r:${sibling.user.id}`);f.advance(1000);assert.equal(f.timers.size,0);
});

test('renewed leases survive canceled old callbacks; close cancels every live timer',t=>{
 const f=fixture(t),a=f.add(),b=f.add();start(f,a);const old=f.timerHistory[0];f.advance(2000);start(f,a,2);f.clear();old();assert.equal(typing(f).length,0);assert.equal(f.timers.size,1);f.text.close();assert.equal(f.timers.size,0);assert.equal(typing(f,b).length,1);old();assert.equal(typing(f,b).length,1);
});

// Hard ceilings are exercised without weakening production limits or allocating
// thousands of real sockets. HTTP tests above use actual sessions and streams.
function boundedFixture(){
 let order=0,at=1000,timer=0;const connections=new Map(),timers=new Map();
 const policy=b=>({...b,available:true,canSend:true,reason:null,conversationRecipients:[]});
 const authority={order:()=>order,current:s=>s,contextFor(s,c){return policy(c.p);},capture(s,b){const client=[...connections.get(s.token_hash)].find(c=>c.proximityText.epoch===b.connectionEpoch);return{s,client,p:policy(b)};},begin(s){const client=[...connections.get(s.token_hash)][0];return{...client.p,token:s.token_hash,order:++order,sourceEpochs:new Set([client.proximityText.epoch]),targets:[]};}};
 const service=createProximityTyping({store:{user:id=>({id,name:'Member'})},connections,sse(){},now:()=>at,authority,timers:{setTimeout(fn){const id=++timer;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}}});
 function add(id,accountId=id){const s={token_hash:`token-${id}`,user_id:`account-${accountId}`,current_room_id:'r',expires_at:1000000},c={res:{destroyed:false,writableEnded:false},proximityText:{epoch:`epoch-${id}`}};c.p={connectionEpoch:c.proximityText.epoch,roomId:'r',bubbleId:'bubble',memberId:`member-${accountId}`,membershipRevision:1};connections.set(s.token_hash,new Set([c]));return{s,c};}
 const update=(a,seq=1,isTyping=false)=>service.update(a.s,typingBody(a.c.p,seq,isTyping),service.begin(a.s));
 return{service,connections,add,update,timers,advance(ms){at+=ms;},authority};
}

test('watermark and lease ceilings are bounded at 64/account and 8192 total, including stopped sources',()=>{
 const f=boundedFixture();try{
  const first=[];for(let i=0;i<64;i++){const a=f.add(i,'same');first.push(a);f.update(a);}
  const excess=f.add('excess','same');assert.throws(()=>f.update(excess),e=>e.code==='PROXIMITY_TYPING_CAPACITY');
  for(let i=64;i<8192;i++)f.update(f.add(i));assert.throws(()=>f.update(f.add('global-excess')),e=>e.code==='PROXIMITY_TYPING_CAPACITY');assert.equal(f.timers.size,0);
  f.service.retireClient(first[0].c);assert.deepEqual(f.update(excess),{accepted:false});assert.equal(f.timers.size,0);
 }finally{f.service.close();}
});

test('account quota survives epoch retirement, is independent of source caps and permits stops',()=>{
 const f=boundedFixture();try{
  for(let i=0;i<8;i++){const a=f.add(i,'same');assert.equal(f.update(a,1,true).accepted,true);assert.equal(f.update(a,2,false).accepted,true);f.service.retireClient(a.c);}
  const next=f.add('next','same');assert.throws(()=>f.update(next,1,true),e=>e.code==='PROXIMITY_TYPING_RATE_LIMITED');assert.equal(f.update(next,2,false).accepted,false);f.advance(500);assert.equal(f.update(next,3,true).accepted,true);
 }finally{f.service.close();}
});

test('recipient contribution capacity is bounded and stops immediately release capacity',()=>{
 const f=boundedFixture(),sources=Array.from({length:65},(_,i)=>f.add(`source-${i}`)),targets=Array.from({length:1024},(_,i)=>f.add(`target-${i}`));
 const targetRecords=targets.map(a=>({token:a.s.token_hash,client:a.c,session:a.s,epoch:a.c.proximityText.epoch,memberId:a.c.p.memberId}));
 const begin=f.authority.begin,context=f.authority.contextFor;
 f.authority.begin=s=>({...begin(s),targets:targetRecords});
 f.authority.contextFor=(s,c)=>({...context(s,c),conversationRecipients:sources.map(a=>({accountId:a.s.user_id,memberId:a.c.p.memberId}))});
 try{
  for(const a of sources.slice(0,64))assert.equal(f.update(a,1,true).accepted,true);
  assert.equal(f.timers.size,64);assert.throws(()=>f.update(sources[64],1,true),e=>e.code==='PROXIMITY_TYPING_CAPACITY');assert.equal(f.timers.size,64);
  assert.equal(f.update(sources[0],2,false).accepted,true);assert.equal(f.timers.size,63);assert.equal(f.update(sources[64],2,true).accepted,true);assert.equal(f.timers.size,64);
 }finally{f.service.close();}assert.equal(f.timers.size,0);
});

test('a rejected text operation still flushes cleanup queued by source epoch rotation',t=>{
 const f=fixture(t),a=f.add(),b=f.add();start(f,a);const p=f.text.context(a.session,a.client.proximityText.epoch),batch=f.text.begin(a.session);f.clear();a.client.proximityText.count=128;
 assert.throws(()=>f.text.send(a.session,f.body(p),batch),e=>e.status===409);assert.equal(f.timers.size,0);assert.equal(typing(f,b).length,1);assert.equal(typing(f,b)[0].data.isTyping,false);
});
