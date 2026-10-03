// Loopback HTTP/SSE and real SQLite. No devices, provider, credentials or SFU.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer} from '../server/app.mjs';
import {proximityFixture} from './fixtures/proximity-config.mjs';
import {PROXIMITY_TYPING,PROXIMITY_TYPING_LIMITS} from '../server/proximity-typing.mjs';
const scene={version:1,theme:'garden',bounds:{width:100,depth:100},spawn:{x:0,z:0},objects:[],areas:[]};
const seeds=[{id:'world',name:'World',rooms:['r','other'].map(id=>({id,name:id,scene}))}];
async function fixture(t,options={}){
 let time=1800000000000,timerId=0;const scheduled=new Map(),timerHistory=[];const timers={setTimeout(fn,delay){const id=++timerId;scheduled.set(id,{fn,at:time+delay});timerHistory.push(fn);return id;},clearTimeout(id){scheduled.delete(id);}};const app=createGameServer({database:':memory:',seeds,questsEnabled:false,clock:()=>time,proximityMembershipConfig:proximityFixture,proximityTextConfig:{enabled:true},proximityTypingTimers:timers,...options});const{port}=await app.listen(0),base=`http://127.0.0.1:${port}`;t.after(()=>app.close());
 function client(cookie=''){return{cookie,async call(path,method='GET',body){const r=await fetch(base+path,{method,headers:{...(this.cookie?{cookie:this.cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))this.cookie=r.headers.get('set-cookie').split(';')[0];return{status:r.status,data:await r.json()};}};}
 async function add(name){const c=client();const r=await c.call('/api/session','POST',{name,woka:0});assert.equal(r.status,201);c.user=r.data.user;assert.equal((await c.call('/api/rooms/r/join','POST',{})).status,200);return c;}
 function sameUser(c){const token=randomBytes(32).toString('base64url'),hash=createHash('sha256').update(token).digest('hex');app.store.run('INSERT INTO sessions VALUES(?,?,?,?)',hash,c.user.id,time+1000000,'r');const copy=client(`universe_session=${token}`);copy.user=c.user;return copy;}
 const hash=c=>createHash('sha256').update(c.cookie.split('=')[1]).digest('hex');
 async function context(c,stream){for(let i=0;i<3;i++){const epoch=stream.events.filter(e=>e.event==='proximity-text-context').at(-1)?.data.connectionEpoch;const r=await c.call('/api/proximity-text?connectionEpoch='+epoch);if(r.status===409&&r.data.code==='STALE_PROXIMITY_TEXT_CONNECTION'){await stream.wait(e=>e.event==='proximity-text-context'&&e.data.connectionEpoch!==epoch);continue;}assert.equal(r.status,200,JSON.stringify(r));return r.data;}throw Error('Context did not stabilize');}
 const envelope=(p,text='hello',extra={})=>({requestId:randomUUID(),text,...Object.fromEntries(['connectionEpoch','roomId','bubbleId','memberId','membershipRevision'].map(key=>[key,p[key]])),...extra});
 return{app,base,add,sameUser,hash,context,envelope,timers:scheduled,timerHistory,advance(ms){time+=ms;for(const[id,timer]of [...scheduled])if(timer.at<=time){scheduled.delete(id);timer.fn();}},get time(){return time;}};
}
async function stream(t,f,c){
 let serverRequest;const observe=req=>{if(req.url==='/api/events'&&req.headers.cookie===c.cookie){serverRequest=req;f.app.server.off('request',observe);}};f.app.server.on('request',observe);
 const controller=new AbortController(),events=[],waiters=new Set();const response=await fetch(f.base+'/api/events',{headers:{cookie:c.cookie},signal:controller.signal});assert.equal(response.status,200);const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
 const reading=(async()=>{try{for(;;){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const event=block.match(/^event: (.+)$/m)?.[1],data=block.match(/^data: (.+)$/m)?.[1];if(event&&data){events.push({event,data:JSON.parse(data)});for(const check of waiters)check();}}}}catch(e){if(e.name!=='AbortError')throw e;}})();
 const close=async()=>{const closed=serverRequest&&!serverRequest.destroyed?new Promise(resolve=>serverRequest.once('close',resolve)):Promise.resolve();controller.abort();await reading;await closed;};t.after(close);
 const result={events,close,wait(predicate,after=0){const find=()=>events.slice(after).find(predicate);if(find())return Promise.resolve(find());return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{waiters.delete(check);reject(Error('SSE fixture timed out'));},2000);const check=()=>{const found=find();if(found){clearTimeout(timeout);waiters.delete(check);resolve(found);}};waiters.add(check);check();});}};
 await result.wait(e=>e.event==='hello');return result;
}
const texts=stream=>stream.events.filter(e=>e.event==='proximity-text-message');
async function barrier(c,stream){const n=stream.events.length;await c.call('/api/presence','POST',{roomId:'r',x:0,z:0,moving:false});await stream.wait(e=>e.event==='proximity-text-context',n);}
async function setup(t,count=3,options){const f=await fixture(t,options),clients=[];for(let i=0;i<count;i++)clients.push(await f.add('Player '+i));const streams=[];for(const c of clients)streams.push(await stream(t,f,c));await streams[0].wait(e=>e.event==='proximity-text-context');return{...f,clients,streams};}
function delayedPost(f,c,body,path='/api/proximity-text/typing'){
 let resolve,reject;const done=new Promise((a,b)=>{resolve=a;reject=b;});
 const req=http.request(f.base+path,{method:'POST',headers:{cookie:c.cookie,'content-type':'application/json'}},res=>{let result='';res.on('data',c=>result+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(result)}));});req.on('error',reject);req.write('{');
 return{done,finish(){req.end(JSON.stringify(body).slice(1));},ready:new Promise(resolve=>setTimeout(resolve,20))};
}

const typing=stream=>stream.events.filter(e=>e.event==='proximity-typing');
const request=(p,sequence=1,isTyping=true,extra={})=>({...Object.fromEntries(['connectionEpoch','roomId','bubbleId','memberId','membershipRevision'].map(key=>[key,p[key]])),sequence,isTyping,...extra});
const post=(c,p,sequence=1,isTyping=true,extra={})=>c.call('/api/proximity-text/typing','POST',request(p,sequence,isTyping,extra));
async function drain(c,s){const n=s.events.length;await c.call('/api/proximity-text?connectionEpoch='+s.events.filter(e=>e.event==='proximity-text-context').at(-1).data.connectionEpoch);await s.wait(e=>e.event==='proximity-text-context',n);}

test('typing is a configured text extension; disabled route emits no typing metadata',async t=>{
 const f=await setup(t,2),[a]=f.clients,[sa]=f.streams,p=await f.context(a,sa);assert.deepEqual(p.typing,PROXIMITY_TYPING);
 const off=await fixture(t,{proximityTextConfig:undefined}),c=await off.add('Off'),s=await stream(t,off,c);
 assert.equal((await post(c,p)).status,404);assert.equal((await c.call('/api/proximity-text')).data.typing,undefined);assert.equal(typing(s).length,0);
});

test('typing uses current identity, all-member AV-off audience and no transcript side effects',async t=>{
 const f=await setup(t,3),[a,b,c]=f.clients,[sa,sb,sc]=f.streams;
 const outsider=await f.add('Outsider');await outsider.call('/api/presence','POST',{roomId:'r',x:20,z:0,moving:false});const so=await stream(t,f,outsider);
 const other=await f.add('Other');await other.call('/api/rooms/other/join','POST',{});const sx=await stream(t,f,other);
 const p=await f.context(a,sa);assert.equal((await a.call('/api/media')).data.enabled,false);f.app.store.run('UPDATE users SET name=? WHERE id=?','Current author',a.user.id);
 assert.deepEqual(await post(a,p),{status:200,data:{accepted:true}});
 const e=(await sb.wait(e=>e.event==='proximity-typing')).data;await sc.wait(e=>e.event==='proximity-typing');
 assert.deepEqual(Object.keys(e).sort(),['protocol','roomId','bubbleId','membershipRevision','recipient','author','fromMemberId','sourceId','revision','isTyping','serverTime','expiresAt'].sort());assert.deepEqual(e.author,{id:a.user.id,name:'Current author'});assert.equal(e.expiresAt-e.serverTime,12000);assert.equal(e.recipient.connectionEpoch,(await f.context(b,sb)).connectionEpoch);
 assert.equal(typing(sa).length+typing(so).length+typing(sx).length,0);assert.equal(f.app.store.get('SELECT count(*) AS n FROM messages').n,0);assert.equal(f.app.store.get('SELECT count(*) AS n FROM direct_messages').n,0);
 for(let i=2;i<=140;i++)assert.equal((await post(a,p,i,false)).status,200);
 assert.equal((await f.context(a,sa)).connectionEpoch,p.connectionEpoch);assert.equal(texts(sb).length,0);assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(p,'text unaffected'))).status,201);
});

test('strict seven-key schema rejects draft, identity, target, lease, bool and integer forgeries',async t=>{
 const f=await setup(t,2),[a]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa);
 for(const extra of[{text:'private draft'},{body:'private draft'},{author:{id:'forged'}},{recipients:[]},{expiresAt:f.time+12000},{sourceId:'forged'},{sequence:0},{sequence:-1},{sequence:1.1},{sequence:Number.MAX_SAFE_INTEGER+1},{sequence:'1'},{isTyping:1},{isTyping:null},{membershipRevision:1.2}])assert.equal((await post(a,p,1,true,extra)).status,400,JSON.stringify(extra));
 const wrong=request(p);delete wrong.sequence;assert.equal((await a.call('/api/proximity-text/typing','POST',wrong)).status,400);
 assert.equal((await post(a,p,1,true,{padding:'x'.repeat(2048)})).status,413);await drain(f.clients[1],sb);assert.equal(typing(sb).length,0);assert.equal(f.timers.size,0);
});

test('per-stream throttle and sequence watermarks do not renew duplicate, lower or early activity',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa);
 await post(a,p,1);await sb.wait(e=>typing(sb).length===1);const first=typing(sb)[0].data;
 f.advance(1000);assert.equal((await post(a,p,2)).data.accepted,false);assert.equal((await post(a,p,1)).data.accepted,false);
 f.advance(1000);assert.equal((await post(a,p,3)).data.accepted,true);await sb.wait(e=>typing(sb).length===2);const second=typing(sb)[1].data;assert.equal(second.expiresAt,first.expiresAt+2000);assert(second.revision>first.revision);
 const staleTimer=f.timerHistory[0];staleTimer();assert.equal(f.timers.size,1);
 f.advance(11999);await drain(b,sb);assert.equal(typing(sb).length,2);f.advance(1);await sb.wait(e=>typing(sb).length===3);assert.equal(typing(sb)[2].data.isTyping,false);assert(typing(sb)[2].data.revision>second.revision);assert.equal(f.timers.size,0);
 assert.equal((await post(a,p,3)).data.accepted,false);await drain(b,sb);assert.equal(typing(sb).length,3);
});

test('delayed starts cannot resurrect after stop or expiry; newer stops bypass exhausted account quota',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa);
 const delayed=delayedPost(f,a,request(p,1));await delayed.ready;assert.equal((await post(a,p,2,false)).status,200);delayed.finish();assert.equal((await delayed.done).data.accepted,false);await drain(b,sb);assert.equal(typing(sb).length,0);
 for(let i=0;i<8;i++){assert.equal((await post(a,p,3+i*2)).status,200);if(i<7)assert.equal((await post(a,p,4+i*2,false)).status,200);}
 assert.equal((await post(a,p,19,false)).data.accepted,true);assert.equal((await post(a,p,20)).status,429);assert.equal((await post(a,p,21,false)).status,200);
 f.advance(500);assert.equal((await post(a,p,22)).status,200);const held=delayedPost(f,a,request(p,23));await held.ready;f.advance(12000);held.finish();assert.equal((await held.done).data.accepted,false);await drain(b,sb);assert.equal(typing(sb).at(-1).data.isTyping,false);
});

test('same-cookie and separate-session siblings retain independent contributions on stop, text and close',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,sa2=await stream(t,f,a),a3=f.sameUser(a),sa3=await stream(t,f,a3);
 const p=await f.context(a,sa),p2=await f.context(a,sa2),p3=await f.context(a3,sa3);await post(a,p);await post(a,p2);await post(a3,p3);await sb.wait(e=>typing(sb).length===3);
 const starts=typing(sb).map(e=>e.data);assert.equal(new Set(starts.map(e=>e.sourceId)).size,3);assert.equal(new Set(starts.map(e=>e.author.id)).size,1);assert.equal(typing(sa).length+typing(sa2).length+typing(sa3).length,0);
 await post(a,p,2,false);await sb.wait(e=>typing(sb).length===4);assert.equal(typing(sb)[3].data.sourceId,starts[0].sourceId);
 await a.call('/api/proximity-text/messages','POST',f.envelope(p2));await sb.wait(e=>typing(sb).length===5);assert.equal(typing(sb)[4].data.sourceId,starts[1].sourceId);
 await sa3.close();await sb.wait(e=>typing(sb).length===6);assert.equal(typing(sb)[5].data.sourceId,starts[2].sourceId);assert.equal(typing(sb).slice(3).every(e=>!e.data.isTyping),true);
});

test('text request-order fence defeats older delayed typing and delayed text preserves newer activity',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa);
 const older=delayedPost(f,a,request(p,1));await older.ready;assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(p))).status,201);older.finish();assert.equal((await older.done).data.accepted,false);
 const heldText=delayedPost(f,a,f.envelope(p),'/api/proximity-text/messages');await heldText.ready;assert.equal((await post(a,p,2)).data.accepted,true);await sb.wait(e=>typing(sb).length===1);heldText.finish();assert.equal((await heldText.done).status,201);await drain(b,sb);assert.equal(typing(sb).length,1);assert.equal(typing(sb)[0].data.isTyping,true);
});

test('late and replaced recipient streams never inherit a pending activity snapshot',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa),held=delayedPost(f,a,request(p));await held.ready;
 const late=await stream(t,f,b),b2=f.sameUser(b),s2=await stream(t,f,b2);await sb.close();const replacement=await stream(t,f,b);held.finish();assert.equal((await held.done).status,200);await drain(b,late);await drain(b2,s2);await drain(b,replacement);
 assert.equal(typing(late).length+typing(s2).length+typing(replacement).length,0);f.advance(2000);assert.equal((await post(a,await f.context(a,sa),2)).status,200);await late.wait(e=>e.event==='proximity-typing');await s2.wait(e=>e.event==='proximity-typing');
});

for(const mutation of['room','status','expiry','ban','mute','presence'])test(`typing body wait revalidates ${mutation}`,async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa),held=delayedPost(f,a,request(p));await held.ready;
 if(mutation==='room')await a.call('/api/rooms/other/join','POST',{});
 if(mutation==='status')f.app.store.run('UPDATE users SET status=? WHERE id=?','dnd',a.user.id);
 if(mutation==='expiry')f.app.store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?',f.time,f.hash(a));
 if(mutation==='ban')f.app.store.run('INSERT INTO members(room_id,user_id,role,banned) VALUES(?,?,?,1)','r',a.user.id,'member');
 if(mutation==='mute')f.app.store.run('INSERT INTO members(room_id,user_id,role,muted_until) VALUES(?,?,?,?)','r',a.user.id,'member',f.time+1000);
 if(mutation==='presence')f.app.presence.delete(`r:${a.user.id}`);
 held.finish();assert((await held.done).status>=400);await drain(b,sb);assert.equal(typing(sb).length,0);assert.equal(f.timers.size,0);
});

for(const action of['silent','meeting','stage','audience'])test(`${action} remains outside ordinary Nearby typing`,async t=>{
 const f=await setup(t,2),[a]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa);
 f.app.store.run('UPDATE rooms SET scene=? WHERE id=?',JSON.stringify({...scene,areas:[{id:'excluded',action,x:0,z:0,width:10,depth:10}]}),'r');
 assert.equal((await post(a,p)).status,403);assert.equal(typing(sb).length,0);
});

test('mute and audience revision cleanup preserve high-water without entering a new audience',async t=>{
 const f=await setup(t,3),[a,b,c]=f.clients,[sa,sb,sc]=f.streams,p=await f.context(a,sa);await post(a,p,10);await sb.wait(e=>typing(sb).length===1);
 assert.equal((await a.call('/api/rooms/r/moderate','POST',{userId:b.user.id,action:'mute'})).status,200);
 // Muted recipients retain incoming contributions; a muted source emits exact stops.
 assert.equal((await a.call('/api/rooms/r/moderate','POST',{userId:c.user.id,action:'mute'})).status,200);assert.equal(f.timers.size,1);
 await c.call('/api/presence','POST',{roomId:'r',x:20,z:0,moving:false});const q=await f.context(a,sa);assert.equal(q.connectionEpoch,p.connectionEpoch);assert.notEqual(q.membershipRevision,p.membershipRevision);assert.equal(f.timers.size,0);
 assert.equal((await post(a,q,10)).data.accepted,false);assert.equal((await post(a,q,11)).status,200);assert.equal(typing(sc).filter(e=>!e.data.isTyping).length,0);
});

test('slow body fails at two seconds without allocating or emitting activity',async t=>{
 const f=await setup(t,2),[a]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa),held=delayedPost(f,a,request(p));const r=await held.done;assert.equal(r.status,408);assert.equal(r.data.code,'PROXIMITY_TYPING_BODY_TIMEOUT');held.finish();assert.equal(typing(sb).length,0);assert.equal(f.timers.size,0);
});

test('ordinary runtime expires a lost stop at twelve seconds without host heartbeat',async t=>{
 const f=await setup(t,2,{clock:Date.now,proximityTypingTimers:undefined}),[a]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa);await post(a,p);const start=(await sb.wait(e=>e.event==='proximity-typing')).data;
 await new Promise(resolve=>setTimeout(resolve,12200));const stop=typing(sb).find(e=>!e.data.isTyping)?.data;assert(stop);assert.equal(stop.sourceId,start.sourceId);assert(stop.serverTime>=start.expiresAt);assert(stop.serverTime-start.expiresAt<1000);
});

for(const action of['mute','kick','ban'])test(`moderation ${action} retires active source metadata immediately`,async t=>{
 const f=await setup(t,3),[owner,b,c]=f.clients,[so,sb,sc]=f.streams,p=await f.context(b,sb);await post(b,p);await so.wait(e=>typing(so).length===1);await sc.wait(e=>typing(sc).length===1);
 const result=await owner.call('/api/rooms/r/moderate','POST',{userId:b.user.id,action});assert.equal(result.status,200);assert.equal(f.timers.size,0);
 await drain(owner,so);if(action==='mute'){assert.equal(typing(so).at(-1).data.isTyping,false);assert.equal((await post(b,p,2)).status,403);}else assert.equal((await f.context(owner,so)).conversationRecipients.some(peer=>peer.accountId===b.user.id),false);
});

test('typing performs no durable database writes and does not consume the text burst',async t=>{
 const f=await setup(t,2),[a]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa),tables=f.app.store.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);
 const snapshot=()=>tables.map(name=>[name,f.app.store.all(`SELECT * FROM "${name}"`)]),before=snapshot();
 for(let i=0;i<8;i++){await post(a,p,i*2+1);await post(a,p,i*2+2,false);}assert.equal((await post(a,p,17)).status,429);assert.deepEqual(snapshot(),before);
 for(let i=0;i<5;i++)assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(p))).status,201);assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(p))).status,429);
});

test('room-muted recipients retain incoming typing and receive new starts, renewals and stops',async t=>{
 const f=await setup(t,3),[owner,muted,peer]=f.clients,[so,sm,sp]=f.streams;
 const op=await f.context(owner,so),mp=await f.context(muted,sm);
 await post(owner,op);await post(muted,mp);await sm.wait(e=>typing(sm).length===1);await so.wait(e=>typing(so).length===1);assert.equal(f.timers.size,2);
 const incomingSource=typing(sm)[0].data.sourceId,outgoingSource=typing(so)[0].data.sourceId;
 assert.equal((await owner.call('/api/rooms/r/moderate','POST',{userId:muted.user.id,action:'mute'})).status,200);
 await so.wait(e=>e.event==='proximity-typing'&&!e.data.isTyping&&e.data.sourceId===outgoingSource);
 await sp.wait(e=>e.event==='proximity-typing'&&!e.data.isTyping&&e.data.sourceId===outgoingSource);
 const mutedContext=await f.context(muted,sm);assert.equal(mutedContext.canSend,false);assert.equal(mutedContext.reason,'muted');assert.equal(mutedContext.connectionEpoch,mp.connectionEpoch);assert.equal(f.timers.size,1);
 assert.equal((await post(muted,mutedContext,2)).status,403);
 const tables=f.app.store.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);
 const snapshot=()=>tables.map(name=>[name,f.app.store.all(`SELECT * FROM "${name}"`)]),before=snapshot();
 // This stop has no intervening renewal, so it also proves observe preserved
 // the already-admitted recipient contribution while its canSend became false.
 assert.equal((await post(owner,op,2,false)).data.accepted,true);
 await sm.wait(e=>typing(sm).length===2);assert.equal(typing(sm)[1].data.isTyping,false);assert.equal(typing(sm)[1].data.sourceId,incomingSource);assert.equal(f.timers.size,0);
 assert.equal((await post(owner,op,3)).data.accepted,true);await sm.wait(e=>typing(sm).length===3);const start=typing(sm)[2].data;
 f.advance(2000);assert.equal((await post(owner,op,4)).data.accepted,true);await sm.wait(e=>typing(sm).length===4);const renewal=typing(sm)[3].data;
 assert.equal(start.isTyping,true);assert.equal(renewal.isTyping,true);assert.equal(renewal.sourceId,incomingSource);assert(renewal.revision>start.revision);assert.equal(renewal.expiresAt,start.expiresAt+2000);
 assert.equal((await post(owner,op,5,false)).data.accepted,true);await sm.wait(e=>typing(sm).length===5);const stop=typing(sm)[4].data;assert.equal(stop.isTyping,false);assert.equal(stop.sourceId,incomingSource);assert(stop.revision>renewal.revision);assert.equal(f.timers.size,0);
 assert.deepEqual(snapshot(),before);assert.equal((await f.context(owner,so)).connectionEpoch,op.connectionEpoch);assert.equal(texts(sm).length,0);
 for(const event of typing(sm))assert.deepEqual(Object.keys(event.data).sort(),['protocol','roomId','bubbleId','membershipRevision','recipient','author','fromMemberId','sourceId','revision','isTyping','serverTime','expiresAt'].sort());
 for(let i=0;i<5;i++)assert.equal((await owner.call('/api/proximity-text/messages','POST',f.envelope(op))).status,201);await sm.wait(e=>texts(sm).length===5);assert.equal(f.app.store.get('SELECT count(*) AS n FROM messages').n,0);
});
