// Loopback HTTP/SSE and real SQLite. No devices, provider, credentials or SFU.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {proximityFixture} from './fixtures/proximity-config.mjs';
import {PROXIMITY_CONTROLS} from '../server/proximity-controls.mjs';
const scene={version:1,theme:'garden',bounds:{width:100,depth:100},spawn:{x:0,z:0},objects:[],areas:[]};
const seeds=[{id:'world',name:'World',rooms:['r','other'].map(id=>({id,name:id,scene}))}];
async function fixture(t,options={}){
 let time=1800000000000,timerId=0;const scheduled=new Map(),timerHistory=[];const timers={setTimeout(fn,delay){const id=++timerId;scheduled.set(id,{fn,at:time+delay});timerHistory.push(fn);return id;},clearTimeout(id){scheduled.delete(id);}};const app=createGameServer({database:':memory:',seeds,questsEnabled:false,clock:()=>time,proximityMembershipConfig:proximityFixture,proximityTextConfig:{enabled:true},proximityTypingTimers:timers,...options});const{port}=await app.listen(0),base=`http://127.0.0.1:${port}`;t.after(()=>app.close());
 function client(cookie=''){return{cookie,async call(path,method='GET',body){const r=await fetch(base+path,{method,headers:{...(this.cookie?{cookie:this.cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))this.cookie=r.headers.get('set-cookie').split(';')[0];return{status:r.status,data:await r.json()};}};}
 async function add(name){const c=client();const r=await c.call('/api/session','POST',{name,woka:0});assert.equal(r.status,201);c.user=r.data.user;assert.equal((await c.call('/api/rooms/r/join','POST',{})).status,200);return c;}
 function sameUser(c){const token=randomBytes(32).toString('base64url'),hash=createHash('sha256').update(token).digest('hex');app.store.run('INSERT INTO sessions VALUES(?,?,?,?)',hash,c.user.id,time+1000000,'r');const copy=client(`universe_session=${token}`);copy.user=c.user;return copy;}
 const hash=c=>createHash('sha256').update(c.cookie.split('=')[1]).digest('hex');
 async function context(c,stream){for(let i=0;i<3;i++){const epoch=stream.events.filter(e=>e.event==='proximity-controls').at(-1)?.data.connectionId;const r=await c.call('/api/proximity-controls?connectionId='+epoch);if(r.status===409&&r.data.code==='STALE_CONTROL_CONNECTION'){await stream.wait(e=>e.event==='proximity-controls'&&e.data.connectionId!==epoch);continue;}assert.equal(r.status,200,JSON.stringify(r));return r.data;}throw Error('Context did not stabilize');}
 return{app,base,add,sameUser,hash,context,controls:options.proximityMembershipConfig!==undefined||!Object.hasOwn(options,'proximityMembershipConfig'),timers:scheduled,timerHistory,advance(ms){time+=ms;for(const[id,timer]of [...scheduled])if(timer.at<=time){scheduled.delete(id);timer.fn();}},get time(){return time;}};
}
async function stream(t,f,c){
 let serverRequest;const observe=req=>{if(req.url==='/api/events'&&req.headers.cookie===c.cookie){serverRequest=req;f.app.server.off('request',observe);}};f.app.server.on('request',observe);
 const controller=new AbortController(),events=[],waiters=new Set();const response=await fetch(f.base+'/api/events',{headers:{cookie:c.cookie},signal:controller.signal});assert.equal(response.status,200);const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
 const reading=(async()=>{try{for(;;){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const event=block.match(/^event: (.+)$/m)?.[1],data=block.match(/^data: (.+)$/m)?.[1];if(event&&data){events.push({event,data:JSON.parse(data)});for(const check of waiters)check();}}}}catch(e){if(e.name!=='AbortError')throw e;}})();
 const close=async()=>{const closed=serverRequest&&!serverRequest.destroyed?new Promise(resolve=>serverRequest.once('close',resolve)):Promise.resolve();controller.abort();await reading;await closed;};t.after(close);
 const result={events,close,wait(predicate,after=0){const find=()=>events.slice(after).find(predicate);if(find())return Promise.resolve(find());return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{waiters.delete(check);reject(Error('SSE fixture timed out'));},2000);const check=()=>{const found=find();if(found){clearTimeout(timeout);waiters.delete(check);resolve(found);}};waiters.add(check);check();});}};
 await result.wait(e=>e.event==='hello');if(f.controls!==false)await result.wait(e=>e.event==='proximity-controls');return result;
}
async function setup(t,count=3,options){const f=await fixture(t,options),clients=[];for(let i=0;i<count;i++)clients.push(await f.add('Player '+i));const streams=[];for(const c of clients)streams.push(await stream(t,f,c));await streams[0].wait(e=>e.event==='proximity-controls');return{...f,clients,streams};}
function delayedPost(f,c,body,path='/api/proximity-controls/action'){
 let resolve,reject;const done=new Promise((a,b)=>{resolve=a;reject=b;});
 const req=http.request(f.base+path,{method:'POST',headers:{cookie:c.cookie,'content-type':'application/json'}},res=>{let result='';res.on('data',c=>result+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(result)}));});req.on('error',reject);req.write('{');
 return{done,finish(){req.end(JSON.stringify(body).slice(1));},ready:new Promise(resolve=>setTimeout(resolve,20))};
}

const command=(p,action,extra={})=>({...Object.fromEntries(['connectionId','roomId','memberId','bubbleId','membershipRevision','controlRevision','stateRevision'].map(k=>[k,p[k]])),operationId:randomUUID(),action,...extra});
const post=(c,p,action,extra)=>c.call('/api/proximity-controls/action','POST',command(p,action,extra));
const controlEvents=s=>s.events.filter(e=>e.event==='proximity-controls');
async function invite(f,leaderIndex=0){const p=await f.context(f.clients[leaderIndex],f.streams[leaderIndex]);const result=await post(f.clients[leaderIndex],p,'invite');assert.equal(result.status,200,JSON.stringify(result));return result.data.state;}
async function accept(f,followerIndex=1,leaderIndex=0){await invite(f,leaderIndex);const p=await f.context(f.clients[followerIndex],f.streams[followerIndex]);const i=p.invitations.find(i=>i.leaderId===f.clients[leaderIndex].user.id);assert(i);const result=await post(f.clients[followerIndex],p,'accept',{invitationId:i.invitationId});assert.equal(result.status,200,JSON.stringify(result));return result.data.state;}
const move=(c,x,extra={})=>c.call('/api/presence','POST',{roomId:'r',x,z:0,moving:true,...extra});

test('controls follow explicit membership capability and require authenticated live SSE admission',async t=>{
 const off=await fixture(t,{proximityMembershipConfig:undefined,proximityTextConfig:undefined}),c=await off.add('Off'),s=await stream(t,off,c);
 assert.deepEqual((await c.call('/api/proximity-controls')).data,{protocol:'proximity-controls-v1',available:false,reason:'disabled'});assert.equal((await c.call('/api/proximity-controls/action','POST',{})).status,404);assert.equal(controlEvents(s).length,0);
 const f=await setup(t,2),[a]=f.clients,[sa]=f.streams,p=await f.context(a,sa);
 assert.equal(p.available,true);assert.equal(p.accountId,a.user.id);assert.equal(p.canLock,true);assert.equal(p.participants.length,2);assert.equal(p.limits.invitationTtlMs,30000);assert.equal(p.following,null);assert.equal((await a.call('/api/media')).data.enabled,false);
 assert.equal((await post(a,{...p,connectionId:randomUUID()},'lock',{locked:true})).status,409);
 const noCookie=await fetch(f.base+'/api/proximity-controls');assert.equal(noCookie.status,401);
});

test('any guest participant can lock/unlock without media, transport, Nearby stay or typing restart',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(b,sb);
 const text=(await b.call('/api/proximity-text?connectionEpoch='+sb.events.filter(e=>e.event==='proximity-text-context').at(-1).data.connectionEpoch)).data;
 const typingBody={...Object.fromEntries(['connectionEpoch','roomId','bubbleId','memberId','membershipRevision'].map(k=>[k,text[k]])),sequence:1,isTyping:true};
 assert.equal((await b.call('/api/proximity-text/typing','POST',typingBody)).status,200);await sa.wait(e=>e.event==='proximity-typing'&&e.data.isTyping);
 const before=(await b.call('/api/media')).data.proximityMembership,locked=await post(b,p,'lock',{locked:true});assert.equal(locked.status,200);assert.equal(locked.data.state.locked,true);assert.equal(locked.data.state.controlRevision,p.controlRevision+1);
 const after=(await b.call('/api/media')).data.proximityMembership;assert.deepEqual(after,before);assert.equal(sa.events.filter(e=>e.event==='proximity-typing'&&!e.data.isTyping).length,0);assert.equal(f.timers.size,1);
 const afterText=(await b.call('/api/proximity-text?connectionEpoch='+text.connectionEpoch)).data;assert.equal(afterText.connectionEpoch,text.connectionEpoch);assert.equal(afterText.membershipRevision,text.membershipRevision);
 const c=await f.add('Third'),sc=await stream(t,f,c);assert.equal((await f.context(c,sc)).bubbleId,null);
 assert.equal((await post(a,await f.context(a,sa),'lock',{locked:false})).status,200);assert.equal((await f.context(c,sc)).bubbleId,p.bubbleId);
});

test('owner outside current bubble gains no controls and forged/cross-room/resident identities fail',async t=>{
 const f=await setup(t,3),[owner,b,c]=f.clients,[so,sb,sc]=f.streams;await move(owner,30);
 const p=await f.context(owner,so),q=await f.context(b,sb);assert.equal(p.bubbleId,null);assert.equal(p.canLock,false);assert.equal(q.participants.length,2);
 assert.equal((await post(owner,p,'lock',{locked:true})).status,403);assert.equal((await post(owner,{...q,connectionId:p.connectionId},'lock',{locked:true})).status,409);
 for(const extra of [{accountId:owner.user.id},{actorId:owner.user.id},{forceFollow:true},{leaderId:'resident-1'},{recipients:[c.user.id]},{stateRevision:1.2},{locked:'true'},{membershipRevision:-1}])assert.equal((await post(b,q,'lock',{locked:true,...extra})).status,400,JSON.stringify(extra));
 assert.equal((await post(b,{...q,roomId:'other'},'invite')).status,409);assert.equal((await post(b,{...q,memberId:'resident-1'},'invite')).status,409);
 assert.equal((await post(b,q,'accept',{invitationId:randomUUID()})).status,403);assert.equal((await post(b,q,'__proto__')).status,400);
 for(const action of [null,[],{},123,{toString:null,valueOf:null}])assert.equal((await post(b,q,action)).status,400);
});

test('ordinary invitations are named, bounded to current bubble and self-only explicit acceptance',async t=>{
 const f=await setup(t,3),[a,b,c]=f.clients,[sa,sb,sc]=f.streams;await invite(f);
 const p=await f.context(b,sb),q=await f.context(c,sc);assert.equal(p.following,null);assert.equal(p.invitations.length,1);assert.equal(p.invitations[0].leaderName,a.user.name);assert.equal(p.invitations[0].expiresAt,f.time+30000);
 assert.equal((await post(c,q,'accept',{invitationId:p.invitations[0].invitationId})).status,403);
 const accepted=await post(b,p,'accept',{invitationId:p.invitations[0].invitationId});assert.equal(accepted.status,200);assert.equal(accepted.data.state.following.controlling,true);assert.equal(accepted.data.state.following.leaderId,a.user.id);assert.equal(accepted.data.state.following.leaderMemberId,(await f.context(a,sa)).memberId);assert.deepEqual(accepted.data.state.following.leaderPresence,{x:0,z:0,moving:false,lastSeen:f.time});
 assert.equal((await f.context(a,sa)).followers[0].accountId,b.user.id);assert.equal((await f.context(c,sc)).following,null);
 assert.equal((await post(c,await f.context(c,sc),'decline',{invitationId:q.invitations[0].invitationId})).status,200);assert.equal((await f.context(c,sc)).invitations.length,0);
});

test('receipts are idempotent, operation reuse is rejected, Stop fences older delayed acceptance',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa),body=command(p,'invite');
 const first=await a.call('/api/proximity-controls/action','POST',body),again=await a.call('/api/proximity-controls/action','POST',body);assert.equal(first.status,200);assert.equal(again.data.duplicate,true);assert.equal(first.data.state.stateRevision,again.data.state.stateRevision);assert.equal((await a.call('/api/proximity-controls/action','POST',{...body,action:'stop'})).status,409);
 const q=await f.context(b,sb),acceptBody=command(q,'accept',{invitationId:q.invitations[0].invitationId}),held=delayedPost(f,b,acceptBody);await held.ready;
 assert.equal((await post(b,q,'stop')).status,200);held.finish();assert.equal((await held.done).status,409);assert.equal((await f.context(b,sb)).following,null);
 assert.equal((await a.call('/api/proximity-controls/action','POST',body)).data.duplicate,true);assert.equal((await f.context(b,sb)).invitations.length,0);
});

test('one accepted stream drives motion; same-cookie and separate-session siblings can stop only',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,sibling=await stream(t,f,b),otherSession=f.sameUser(b),otherStream=await stream(t,f,otherSession),accepted=await accept(f);
 const q=await f.context(b,sibling),r=await f.context(otherSession,otherStream);assert.equal(q.following.controlling,false);assert.equal(q.following.leaseId,null);assert.equal(r.following.controlling,false);
 assert.equal((await move(b,1,{connectionId:q.connectionId,followLeaseId:accepted.following.leaseId})).status,409);assert.equal((await move(otherSession,1,{connectionId:r.connectionId,followLeaseId:accepted.following.leaseId})).status,409);assert.equal((await move(b,1)).status,409);
 assert.equal((await move(b,1,{connectionId:accepted.connectionId,followLeaseId:accepted.following.leaseId})).status,200);
 assert.equal((await post(otherSession,await f.context(otherSession,otherStream),'stop')).status,200);assert.equal((await move(b,2,{connectionId:accepted.connectionId,followLeaseId:accepted.following.leaseId})).status,409);assert.equal((await f.context(b,sb)).following,null);
});

test('simultaneous sibling accept race awards one lease and disconnected/reconnected stream cannot reclaim it',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,sb2=await stream(t,f,b);await invite(f);const p=await f.context(b,sb),q=await f.context(b,sb2),id=p.invitations[0].invitationId;
 const results=await Promise.all([post(b,p,'accept',{invitationId:id}),post(b,q,'accept',{invitationId:id})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const winner=results[0].status===200?sb:sb2,accepted=results.find(r=>r.status===200).data.state;await winner.close();const fresh=await stream(t,f,b),r=await f.context(b,fresh);assert(r.following);assert.equal(r.following.controlling,false);assert.equal(r.following.controllerConnected,false);
 assert.equal((await move(b,1,{connectionId:accepted.connectionId,followLeaseId:accepted.following.leaseId})).status,409);assert.equal((await post(b,r,'stop')).status,200);assert.equal((await f.context(b,fresh)).following,null);
});

test('leader replacement atomically stops previous followers without silently reassigning them',async t=>{
 const f=await setup(t,4),[a,b,c,d]=f.clients,[sa,sb,sc,sd]=f.streams;await accept(f,1,0);await accept(f,2,0);
 assert.equal((await f.context(a,sa)).followers.length,2);await invite(f,3);const q=await f.context(b,sb),i=q.invitations.find(i=>i.leaderId===d.user.id);assert(i);assert.equal((await post(b,q,'accept',{invitationId:i.invitationId})).status,200);
 assert.equal((await f.context(a,sa)).followers.length,0);assert.equal((await f.context(c,sc)).following,null);assert.equal((await f.context(b,sb)).following.leaderId,d.user.id);assert.equal((await f.context(d,sd)).followers.length,1);
 assert.equal((await post(b,await f.context(b,sb),'invite')).status,409);
 assert.equal((await post(d,await f.context(d,sd),'stop')).status,200);assert.equal((await f.context(b,sb)).following,null);
});

test('ignore preference consumes pending invites, prevents new ones and never stops accepted consent',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams;await invite(f);assert.equal((await post(b,await f.context(b,sb),'preferences',{ignoreRequests:true})).status,200);assert.equal((await f.context(b,sb)).invitations.length,0);await invite(f);assert.equal((await f.context(b,sb)).invitations.length,0);
 await post(b,await f.context(b,sb),'preferences',{ignoreRequests:false});await accept(f);await post(b,await f.context(b,sb),'preferences',{ignoreRequests:true});assert.equal((await f.context(b,sb)).following.leaderId,a.user.id);
});

for(const mutation of ['room','expiry','ban','presence','silent','status'])test(`incomplete command body revalidates fresh ${mutation} authority`,async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(b,sb),held=delayedPost(f,b,command(p,'lock',{locked:true}));await held.ready;
 if(mutation==='room')await b.call('/api/rooms/other/join','POST',{});
 if(mutation==='expiry')f.app.store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?',f.time,f.hash(b));
 if(mutation==='ban')f.app.store.run('INSERT INTO members(room_id,user_id,role,banned) VALUES(?,?,?,1)','r',b.user.id,'member');
 if(mutation==='presence')f.app.presence.delete(`r:${b.user.id}`);
 if(mutation==='status')f.app.store.run('UPDATE users SET status=? WHERE id=?','dnd',b.user.id);
 if(mutation==='silent')f.app.store.run('UPDATE rooms SET scene=? WHERE id=?',JSON.stringify({...scene,areas:[{id:'quiet',action:'silent',x:0,z:0,width:10,depth:10}]}),'r');
 held.finish();assert((await held.done).status>=400);assert.equal((await f.context(a,sa)).locked,false);
});

test('expired invitation and changed member set cannot accept or mutate stale context',async t=>{
 const f=await setup(t,3),[a,b,c]=f.clients,[sa,sb,sc]=f.streams;await invite(f);const p=await f.context(b,sb);f.advance(30000);assert.equal((await post(b,p,'accept',{invitationId:p.invitations[0].invitationId})).status,409);assert.equal((await f.context(b,sb)).invitations.length,0);
 await invite(f);const q=await f.context(b,sb);await move(c,30);assert.equal((await post(b,q,'lock',{locked:true})).status,409);
});

test('Silent/status exits preserve accepted room consent; stop works outside bubble and audio leave stays distinct',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,accepted=await accept(f);
 await b.call('/api/media/state','POST',{enabled:false,roomId:'r',memberId:accepted.memberId});assert((await f.context(b,sb)).following);
 f.app.store.run('UPDATE users SET status=? WHERE id=?','dnd',b.user.id);const p=await f.context(b,sb);assert.equal(p.bubbleId,null);assert.equal(p.memberId,accepted.memberId);assert.equal(p.following.leaderId,a.user.id);assert.equal(p.canLock,false);
 assert.equal((await post(b,p,'stop')).status,200);f.app.store.run('UPDATE users SET status=? WHERE id=?','online',b.user.id);assert.equal((await f.context(b,sb)).following,null);
 await accept(f);f.app.store.run('UPDATE rooms SET scene=? WHERE id=?',JSON.stringify({...scene,areas:[{id:'quiet',action:'silent',x:0,z:0,width:10,depth:10}]}),'r');const q=await f.context(b,sb);assert.equal(q.bubbleId,null);assert(q.following);assert.equal((await post(b,q,'stop')).status,200);
});

for(const mutation of ['leader-room','follower-room','leader-expiry','follower-expiry','ban','ttl'])test(`accepted relation retires on actual ${mutation} revocation`,async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,accepted=await accept(f),sibling=f.sameUser(b),ss=await stream(t,f,sibling);
 if(mutation==='leader-room')await a.call('/api/rooms/other/join','POST',{});
 if(mutation==='follower-room')await b.call('/api/rooms/other/join','POST',{});
 if(mutation==='leader-expiry')f.app.store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?',f.time,f.hash(a));
 if(mutation==='follower-expiry')f.app.store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?',f.time,f.hash(b));
 if(mutation==='ban')f.app.store.run('INSERT INTO members(room_id,user_id,role,banned) VALUES(?,?,?,1)','r',a.user.id,'member');
 if(mutation==='ttl')f.advance(60000);
 const p=await f.context(sibling,ss);assert.equal(p.following,null);if(mutation!=='ttl')assert.equal(p.memberId,accepted.memberId);
});

test('validated following feeds source geometry: distant follower retained, unrelated head split',async t=>{
 const f=await setup(t,3),[a,b,c]=f.clients,[sa,sb,sc]=f.streams,accepted=await accept(f),p=await f.context(a,sa);
 assert.equal((await move(b,-10,{connectionId:accepted.connectionId,followLeaseId:accepted.following.leaseId})).status,200);assert.equal((await f.context(b,sb)).bubbleId,p.bubbleId);
 assert.equal((await move(a,10)).status,200);assert.equal((await f.context(b,sb)).bubbleId,p.bubbleId);assert.equal((await f.context(c,sc)).bubbleId,null);assert.equal((await f.context(b,sb)).following.leaderId,a.user.id);
});

test('HTTP state is ephemeral and control operation limits do not block stop',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,tables=f.app.store.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name),snapshot=()=>tables.map(name=>[name,f.app.store.all(`SELECT * FROM "${name}"`)]),before=snapshot();
 for(let n=0;n<PROXIMITY_CONTROLS.maxOperationsPerMinute;n++){const r=await post(a,await f.context(a,sa),'lock',{locked:!!(n%2)});assert.equal(r.status,200);}
 assert.equal((await post(a,await f.context(a,sa),'invite')).status,429);assert.equal((await post(a,await f.context(a,sa),'stop')).status,200);assert.deepEqual(snapshot(),before);
});

test('slow and oversized command bodies fail without control mutation',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa);assert.equal((await post(a,p,'invite',{padding:'x'.repeat(5000)})).status,413);const held=delayedPost(f,a,command(p,'invite'));assert.equal((await held.done).status,408);held.finish();assert.equal((await f.context(b,sb)).invitations.length,0);
});

test('same-room leave and rejoin rotates command connection even when sibling retains admission',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,sibling=f.sameUser(b),ss=await stream(t,f,sibling),p=await f.context(b,sb),held=delayedPost(f,b,command(p,'lock',{locked:true}));await held.ready;
 assert.equal((await b.call('/api/rooms/r/join','POST',{})).status,200);held.finish();assert.equal((await held.done).status,409);const q=await f.context(b,sb);assert.equal(q.memberId,p.memberId);assert.notEqual(q.connectionId,p.connectionId);assert.equal(q.locked,false);assert.equal((await post(b,q,'lock',{locked:true})).status,200);
});

test('leader follow chain cannot be created from crossed invitations',async t=>{
 const f=await setup(t,3),[a,b,c]=f.clients,[sa,sb,sc]=f.streams;await invite(f,0);await invite(f,1);const p=await f.context(b,sb);assert.equal((await post(b,p,'accept',{invitationId:p.invitations.find(i=>i.leaderId===a.user.id).invitationId})).status,200);
 const q=await f.context(a,sa);assert.equal((await post(a,q,'accept',{invitationId:q.invitations.find(i=>i.leaderId===b.user.id).invitationId})).status,409);assert.equal((await f.context(b,sb)).following.leaderId,a.user.id);assert.equal((await f.context(a,sa)).following,null);
});

test('large group leader/follower split carries only consented follower into a new bubble',async t=>{
 const f=await setup(t,4),[a,b,c,d]=f.clients,[sa,sb,sc,sd]=f.streams,accepted=await accept(f),before=await f.context(a,sa);
 assert.equal((await move(a,20)).status,200);const leader=await f.context(a,sa),follower=await f.context(b,sb),other=await f.context(c,sc);assert.notEqual(leader.bubbleId,before.bubbleId);assert.equal(follower.bubbleId,leader.bubbleId);assert.equal(follower.following.leaderId,a.user.id);assert.equal(other.bubbleId,(await f.context(d,sd)).bubbleId);assert.notEqual(other.bubbleId,leader.bubbleId);
 assert.equal((await move(b,18,{connectionId:accepted.connectionId,followLeaseId:accepted.following.leaseId})).status,200);
});

test('invitation state reaches a hard room bound without partial broadcast or exceeding it',async t=>{
 const f=await setup(t,18,{proximityMembershipConfig:{...proximityFixture,membershipCeiling:20}});
 // Each of 15 leaders can initially invite 17 others: 255 invitations total.
 for(let i=0;i<15;i++)await invite(f,i);
 const p=await f.context(f.clients[15],f.streams[15]),before=p.invitations.length,result=await post(f.clients[15],p,'invite');assert.equal(result.status,429);assert.equal(result.data.code,'CONTROL_INVITATION_LIMIT');const after=await f.context(f.clients[15],f.streams[15]);assert.equal(after.invitations.length,before);assert.equal(after.outgoingInvitations.length,0);assert.equal(after.stateRevision,p.stateRevision);
 f.advance(30000);assert.equal((await f.context(f.clients[15],f.streams[15])).invitations.length,0);assert.equal((await post(f.clients[15],await f.context(f.clients[15],f.streams[15]),'invite')).status,200);
});

test('movement body started before accept and Stop cannot overwrite the completed transition',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams;
 const early=delayedPost(f,b,{roomId:'r',x:22,z:0,moving:true},'/api/presence');await early.ready;await accept(f);const p=await f.context(b,sb);assert.equal((await post(b,p,'stop')).status,200);early.finish();assert.equal((await early.done).status,409);assert.equal(f.app.presence.get(`r:${b.user.id}`).x,0);
 const accepted=await accept(f),held=delayedPost(f,b,{roomId:'r',x:24,z:0,moving:true,connectionId:accepted.connectionId,followLeaseId:accepted.following.leaseId},'/api/presence');await held.ready;assert.equal((await post(b,await f.context(b,sb),'stop')).status,200);held.finish();assert.equal((await held.done).status,409);assert.equal(f.app.presence.get(`r:${b.user.id}`).x,0);
});

test('secondary same-room join retains controlling follow position and the accepted lease',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,accepted=await accept(f);assert.equal((await move(b,2,{connectionId:accepted.connectionId,followLeaseId:accepted.following.leaseId})).status,200);
 const sibling=f.sameUser(b),ss=await stream(t,f,sibling);assert.equal((await sibling.call('/api/rooms/r/join','POST',{})).status,200);assert.equal(f.app.presence.get(`r:${b.user.id}`).x,2);const q=await f.context(b,sb);assert.equal(q.following.leaseId,accepted.following.leaseId);assert.equal(q.following.controlling,true);assert.equal((await move(sibling,20)).status,409);
 assert.equal((await b.call('/api/rooms/r/join','POST',{})).status,200);assert.equal((await f.context(sibling,ss)).following,null);assert.equal(f.app.presence.get(`r:${b.user.id}`).x,2);
});

test('partial command body cannot rebind to post-Stop revisions or a new stream after rejoin',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(b,sb),body=command(p,'lock',{locked:true}),held=delayedPost(f,b,body);await held.ready;
 assert.equal((await post(b,p,'stop')).status,200);Object.assign(body,command(await f.context(b,sb),'lock',{locked:true}));held.finish();assert.equal((await held.done).status,409);assert.equal((await f.context(b,sb)).locked,false);
 const sibling=f.sameUser(b),ss=await stream(t,f,sibling),next=command(await f.context(b,sb),'lock',{locked:true}),waiting=delayedPost(f,b,next);await waiting.ready;await b.call('/api/rooms/r/join','POST',{});Object.assign(next,command(await f.context(b,sb),'lock',{locked:true}));waiting.finish();assert.equal((await waiting.done).status,409);assert.equal((await f.context(sibling,ss)).locked,false);
});

test('ordinary delayed movement cannot survive session room ABA while a sibling preserves admission',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,sibling=f.sameUser(b),ss=await stream(t,f,sibling),before=await f.context(b,sb),held=delayedPost(f,b,{roomId:'r',x:19,z:0,moving:true},'/api/presence');await held.ready;
 await b.call('/api/rooms/other/join','POST',{});await b.call('/api/rooms/r/join','POST',{});assert.equal((await f.context(b,sb)).memberId,before.memberId);held.finish();assert.equal((await held.done).status,409);assert.equal(f.app.presence.get(`r:${b.user.id}`).x,0);
});

test('ordinary delayed leader movement cannot survive same-room session rejoin and revoked leadership',async t=>{
 const f=await setup(t,3),[a,b]=f.clients,[sa,sb]=f.streams,sibling=f.sameUser(a),ss=await stream(t,f,sibling);await accept(f);const held=delayedPost(f,a,{roomId:'r',x:19,z:0,moving:true},'/api/presence');await held.ready;
 await a.call('/api/rooms/r/join','POST',{});assert.equal((await f.context(b,sb)).following,null);held.finish();assert.equal((await held.done).status,409);assert.equal(f.app.presence.get(`r:${a.user.id}`).x,0);
});

test('kick fences pending movement even for a session without an SSE stream',async t=>{
 const f=await setup(t,2),[owner,b]=f.clients,sibling=f.sameUser(b),held=delayedPost(f,sibling,{roomId:'r',x:19,z:0,moving:true},'/api/presence');await held.ready;
 assert.equal((await owner.call('/api/rooms/r/moderate','POST',{userId:b.user.id,action:'kick'})).status,200);assert.equal((await sibling.call('/api/rooms/r/join','POST',{})).status,200);held.finish();assert.equal((await held.done).status,409);assert.equal(f.app.presence.get(`r:${b.user.id}`).x,0);
});

test('pending presence fences have per-session limits and release after completion',async t=>{
 const f=await setup(t,2),[a]=f.clients,held=[];for(let i=0;i<PROXIMITY_CONTROLS.maxPendingPresencePerSession;i++){const request=delayedPost(f,a,{roomId:'r',x:0,z:0,moving:false},'/api/presence');await request.ready;held.push(request);}
 assert.equal((await move(a,1)).status,429);for(const request of held)request.finish();for(const request of held)assert.equal((await request.done).status,200);assert.equal((await move(a,1)).status,200);
});
