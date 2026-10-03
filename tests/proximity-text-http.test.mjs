// Loopback HTTP/SSE and real SQLite. No devices, provider, credentials or SFU.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGameServer} from '../server/app.mjs';
import {proximityFixture} from './fixtures/proximity-config.mjs';
import {AVATAR_PRESETS} from '../src/avatar-spec.js';
const scene={version:1,theme:'garden',bounds:{width:100,depth:100},spawn:{x:0,z:0},objects:[],areas:[]};
const seeds=[{id:'world',name:'World',rooms:['r','other'].map(id=>({id,name:id,scene}))}];
async function fixture(t,options={}){
 let time=1800000000000;const app=createGameServer({database:':memory:',seeds,questsEnabled:false,clock:()=>time,proximityMembershipConfig:proximityFixture,proximityTextConfig:{enabled:true},...options});const{port}=await app.listen(0),base=`http://127.0.0.1:${port}`;t.after(()=>app.close());
 function client(cookie=''){return{cookie,async call(path,method='GET',body){const r=await fetch(base+path,{method,headers:{...(this.cookie?{cookie:this.cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))this.cookie=r.headers.get('set-cookie').split(';')[0];return{status:r.status,data:await r.json()};}};}
 async function add(name){const c=client();const r=await c.call('/api/session','POST',{name,woka:0});assert.equal(r.status,201);c.user=r.data.user;assert.equal((await c.call('/api/rooms/r/join','POST',{})).status,200);return c;}
 function sameUser(c){const token=randomBytes(32).toString('base64url'),hash=createHash('sha256').update(token).digest('hex');app.store.run('INSERT INTO sessions VALUES(?,?,?,?)',hash,c.user.id,time+1000000,'r');const copy=client(`universe_session=${token}`);copy.user=c.user;return copy;}
 const hash=c=>createHash('sha256').update(c.cookie.split('=')[1]).digest('hex');
 async function context(c,stream){for(let i=0;i<3;i++){const epoch=stream.events.filter(e=>e.event==='proximity-text-context').at(-1)?.data.connectionEpoch;const r=await c.call('/api/proximity-text?connectionEpoch='+epoch);if(r.status===409&&r.data.code==='STALE_PROXIMITY_TEXT_CONNECTION'){await stream.wait(e=>e.event==='proximity-text-context'&&e.data.connectionEpoch!==epoch);continue;}assert.equal(r.status,200,JSON.stringify(r));return r.data;}throw Error('Context did not stabilize');}
 const envelope=(p,text='hello',extra={})=>({requestId:randomUUID(),text,...Object.fromEntries(['connectionEpoch','roomId','bubbleId','memberId','membershipRevision'].map(key=>[key,p[key]])),...extra});
 return{app,base,add,sameUser,hash,context,envelope,advance(ms){time+=ms;},get time(){return time;}};
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
function delayedPost(f,c,body){
 let resolve,reject;const done=new Promise((a,b)=>{resolve=a;reject=b;});
 const req=http.request(f.base+'/api/proximity-text/messages',{method:'POST',headers:{cookie:c.cookie,'content-type':'application/json'}},res=>{let result='';res.on('data',c=>result+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(result)}));});req.on('error',reject);req.write('{');
 return{done,finish(){req.end(JSON.stringify(body).slice(1));},ready:new Promise(resolve=>setTimeout(resolve,20))};
}

test('explicit text opt-in requires all-member authority; disabled leaves legacy contracts intact',async t=>{
 assert.throws(()=>createGameServer({proximityTextConfig:{enabled:true}}),/all-member/);
 assert.throws(()=>createGameServer({proximityMembershipConfig:proximityFixture,proximityTextConfig:{enabled:false}}),/explicit/);
 const f=await fixture(t,{proximityMembershipConfig:undefined,proximityTextConfig:undefined}),a=await f.add('Legacy'),sa=await stream(t,f,a);
 const result=await a.call('/api/proximity-text');assert.deepEqual(result.data,{protocol:'proximity-text-v1',available:false,canSend:false,reason:'disabled'});
 assert.equal((await a.call('/api/proximity-text/messages','POST',{})).status,404);assert.equal(sa.events.some(e=>e.event.startsWith('proximity-text')),false);
 const media=await a.call('/api/media');assert.equal(media.data.proximityMembership,undefined);assert.equal((await a.call('/api/rooms/r/messages','POST',{text:'persistent still works'})).status,201);
});

test('all microphones off deliver exactly once only to current bubble, using server identity and plain text',async t=>{
 const f=await setup(t,3),[a,b,c]=f.clients,[sa,sb,sc]=f.streams;
 const d=await f.add('Nearby outsider');await d.call('/api/presence','POST',{roomId:'r',x:8,z:0,moving:false});const sd=await stream(t,f,d);
 const e=await f.add('Other room');await e.call('/api/rooms/other/join','POST',{});const se=await stream(t,f,e);
 const p=await f.context(a,sa);assert.equal(p.recipientCount,2);assert.equal(p.canSend,true);assert.equal((await a.call('/api/media')).data.enabled,false);
 f.app.store.run('UPDATE users SET name=? WHERE id=?','Current name',a.user.id);
 const text='<script>globalThis.bad=true</script> **literal** https://example.test/\n💫',request=f.envelope(p,text),r=await a.call('/api/proximity-text/messages','POST',request);assert.equal(r.status,201,JSON.stringify(r));
 const event=await sb.wait(e=>e.event==='proximity-text-message'),ce=await sc.wait(e=>e.event==='proximity-text-message');assert.equal(event.data.text,text);assert.equal(event.data.author.name,'Current name');assert.equal(event.data.author.id,a.user.id);assert.equal(ce.data.id,r.data.message.id);assert.equal(event.data.recipient.connectionEpoch,(await f.context(b,sb)).connectionEpoch);assert.equal(event.data.recipient.memberId,p.conversationRecipients.find(peer=>peer.accountId===b.user.id).memberId);
 assert.equal(texts(sa).length,0);assert.equal(texts(sd).length,0);assert.equal(texts(se).length,0);assert.equal(f.app.store.get('SELECT count(*) AS n FROM messages').n,0);
});

test('six-member text works above P2P threshold, with consent toggles preserving context',async t=>{
 const f=await setup(t,6),a=f.clients[0],sa=f.streams[0],p=await f.context(a,sa),media=(await a.call('/api/media')).data;
 assert.equal(media.proximityMembership.transport.blockedReason,'sfu-unavailable');assert.equal(p.recipientCount,5);
 await a.call('/api/media/state','POST',{enabled:true,roomId:'r',memberId:p.memberId});const q=await f.context(a,sa);assert.equal(q.connectionEpoch,p.connectionEpoch);assert.deepEqual(q.conversationRecipients,p.conversationRecipients);
 assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(q))).status,201);
 for(const s of f.streams.slice(1))await s.wait(e=>e.event==='proximity-text-message');
});

test('strict schema, Unicode/newline bounds, per-account burst/refill and sibling rate sharing',async t=>{
 const f=await setup(t,2),[a]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa);
 for(const change of[{author:{id:'forged'}},{recipients:['forged']},{text:''},{text:' \n\t'},{text:7},{text:'a'.repeat(2001)},{text:'😀'.repeat(2050)},{text:'\ud800'},{text:'\u0000'},{files:[]}])assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(p,'x',change))).status,400);
 for(const text of['😀'.repeat(2000),'x'.repeat(2000),'a\r\nb\rc','é','last']){const r=await a.call('/api/proximity-text/messages','POST',f.envelope(p,text));assert.equal(r.status,201);assert.equal(r.data.message.text,text.replace(/\r\n?/g,'\n'));}
 assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(p))).status,429);
 const a2=f.sameUser(a),sa2=await stream(t,f,a2),p2=await f.context(a2,sa2);assert.equal((await a2.call('/api/proximity-text/messages','POST',f.envelope(p2))).status,429);
 f.advance(1000);assert.equal((await a2.call('/api/proximity-text/messages','POST',f.envelope(p2))).status,201);await sb.wait(e=>texts(sb).length===6);
});

test('same-session retry returns one receipt, changed content fails, and reconnect/leave cannot replay',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa),request=f.envelope(p,'once');
 const first=await a.call('/api/proximity-text/messages','POST',request);assert.equal(first.status,201);
 const second=await a.call('/api/proximity-text/messages','POST',request);assert.equal(second.status,200);assert.equal(second.data.duplicate,true);assert.deepEqual(second.data.message,first.data.message);
 assert.equal((await a.call('/api/proximity-text/messages','POST',{...request,text:'different'})).status,409);await barrier(b,sb);assert.equal(texts(sb).length,1);
 await a.call('/api/rooms/other/join','POST',{});await a.call('/api/rooms/r/join','POST',{});assert.equal((await a.call('/api/proximity-text/messages','POST',request)).status,409);
 const current=await f.context(a,sa),oldConnection=f.envelope(current,'old stream');await sa.close();const replacement=await stream(t,f,a);assert.notEqual((await f.context(a,replacement)).connectionEpoch,current.connectionEpoch);assert.equal((await a.call('/api/proximity-text/messages','POST',oldConnection)).status,409);
});

test('late joins receive no transcript and stale captured membership revision cannot send',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa);
 assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(p,'before'))).status,201);await sb.wait(e=>e.event==='proximity-text-message');
 const c=await f.add('Late'),sc=await stream(t,f,c);assert.equal(texts(sc).length,0);assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(p,'stale'))).status,409);
 const next=await f.context(a,sa);assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(next,'after'))).status,201);assert.equal((await sc.wait(e=>e.event==='proximity-text-message')).data.text,'after');assert.equal(texts(sc).length,1);
 await b.call('/api/rooms/other/join','POST',{});await b.call('/api/rooms/r/join','POST',{});assert.equal(texts(sb).length,2);
 assert.equal((await c.call('/api/proximity-text/messages')).status,404);
});

for(const mutation of['room','status','expiry','ban','presence','mute'])test('delayed body revalidates '+mutation+' before any emission',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa),pending=delayedPost(f,a,f.envelope(p));await pending.ready;
 if(mutation==='room')await a.call('/api/rooms/other/join','POST',{});
 if(mutation==='status')f.app.store.run('UPDATE users SET status=? WHERE id=?','dnd',a.user.id);
 if(mutation==='expiry')f.app.store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?',f.time,f.hash(a));
 if(mutation==='ban')f.app.store.run('INSERT OR REPLACE INTO members(room_id,user_id,role,banned) VALUES(?,?,?,1)','r',a.user.id,'member');
 if(mutation==='presence')f.advance(60000);
 if(mutation==='mute')f.app.store.run('INSERT OR REPLACE INTO members(room_id,user_id,role,muted_until) VALUES(?,?,?,?)','r',a.user.id,'member',f.time+10000);
 pending.finish();const r=await pending.done;assert([401,403,409].includes(r.status),JSON.stringify(r));assert.equal(texts(sb).length,0);
});

for(const kind of['silent','meeting','stage','audience'])test(kind+' contexts never receive ordinary bubble text',async t=>{
 const f=await setup(t,2),a=f.clients[0],p=await f.context(a,f.streams[0]);f.app.store.run('UPDATE rooms SET scene=? WHERE id=?',JSON.stringify({...scene,areas:[{id:'area',action:kind,x:0,z:0,width:10,depth:10}]}),'r');
 const r=await a.call('/api/proximity-text/messages','POST',f.envelope(p));assert.equal(r.status,403);assert.equal(texts(f.streams[1]).length,0);
});

test('sibling sessions get explicit own-account copy, each with independent connection/member evidence',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,a2=f.sameUser(a),b2=f.sameUser(b),sa2=await stream(t,f,a2),sb2=await stream(t,f,b2),p=await f.context(a,sa);
 const request=f.envelope(p),r=await a.call('/api/proximity-text/messages','POST',request);assert.equal(r.status,201);
 for(const s of[sb,sa2,sb2])assert.equal((await s.wait(e=>e.event==='proximity-text-message')).data.id,r.data.message.id);
 assert.equal(texts(sa2)[0].data.ownAccountCopy,true);assert.equal(texts(sb2)[0].data.ownAccountCopy,false);assert.notEqual(texts(sb)[0].data.recipient.connectionEpoch,texts(sb2)[0].data.recipient.connectionEpoch);
 await a2.call('/api/rooms/other/join','POST',{});const before=await f.context(a,sa);await a2.call('/api/rooms/r/join','POST',{});assert.equal((await f.context(a,sa)).memberId,before.memberId);assert.equal((await a.call('/api/proximity-text/messages','POST',request)).status,200);await barrier(b,sb);assert.equal(texts(sa2).length,1);assert.equal(texts(sb2).length,1);
});

test('at-emission recipient revocation and new connection do not inherit captured delivery',async t=>{
 const f=await fixture(t),a=await f.add('A'),b=await f.add('B'),c=await f.add('C');let armed=false,changed=false;
 // This host-only HTTP response seam runs after the first actual emission and
 // before the next. Production code has no delay queue or testing bypass.
 f.app.server.prependListener('request',(req,res)=>{if(req.url!=='/api/events')return;const write=res.write.bind(res);res.write=(chunk,...args)=>{const result=write(chunk,...args);if(armed&&!changed&&String(chunk).startsWith('event: proximity-text-message')){changed=true;f.app.store.run('UPDATE sessions SET current_room_id=NULL WHERE token_hash=?',f.hash(c));}return result;};});
 const sa=await stream(t,f,a),sb=await stream(t,f,b),sc=await stream(t,f,c),p=await f.context(a,sa);armed=true;
 assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(p))).status,201);await sb.wait(e=>e.event==='proximity-text-message');assert.equal(changed,true);assert.equal(texts(sc).length,0);
 await c.call('/api/rooms/r/join','POST',{});const sc2=await stream(t,f,c);assert.equal(texts(sc2).length,0);
});

test('authority read failure sends nothing, exposes no text in logs, and recovery rejects old scope',async t=>{
 const f=await setup(t,2),a=f.clients[0],p=await f.context(a,f.streams[0]),request=f.envelope(p,'PRIVATE BODY SENTINEL');
 const get=f.app.store.get.bind(f.app.store);let broken=true;f.app.store.get=(sql,...args)=>{if(broken&&sql==='SELECT id,status FROM users WHERE id=?')throw Error('synthetic authority failure');return get(sql,...args);};
 const original=console.error,logs=[];console.error=(...args)=>logs.push(args.join(' '));try{const r=await a.call('/api/proximity-text/messages','POST',request);assert.equal(r.status,503);assert.equal(texts(f.streams[1]).length,0);assert.equal(logs.join('\n').includes(request.text),false);}finally{console.error=original;broken=false;}
 assert.equal((await a.call('/api/proximity-text/messages','POST',request)).status,409);
});

test('receipt lifetime rotates epoch and old request cannot become sendable after cache pruning',async t=>{
 const f=await setup(t,2),a=f.clients[0],sa=f.streams[0],p=await f.context(a,sa),request=f.envelope(p);assert.equal((await a.call('/api/proximity-text/messages','POST',request)).status,201);
 for(let i=0;i<3;i++){f.advance(30000);for(const c of f.clients)assert.equal((await c.call('/api/presence','POST',{roomId:'r',x:0,z:0,moving:false})).status,200);}f.advance(30000);
 assert.equal((await a.call('/api/proximity-text/messages','POST',request)).status,409);assert.equal(texts(f.streams[1]).length,1);
});

test('SQLite contains no body and server restart provides no recoverable proximity transcript',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'proximity-text-'));t.after(()=>rm(dir,{recursive:true,force:true}));const database=join(dir,'fixture.sqlite');
 const f=await setup(t,2,{database}),a=f.clients[0],p=await f.context(a,f.streams[0]),marker='unique-nearby-ephemeral-body-6b8a';assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(p,marker))).status,201);await f.streams[1].wait(e=>e.event==='proximity-text-message');
 f.app.store.db.exec('PRAGMA wal_checkpoint(FULL)');assert.equal((await readFile(database)).includes(Buffer.from(marker)),false);
 const restart=await fixture(t,{database}),aAgain={...a,call:undefined};const response=await fetch(restart.base+'/api/proximity-text/messages',{headers:{cookie:a.cookie}});assert.equal(response.status,404);const s=await stream(t,restart,aAgain);assert.equal(texts(s).length,0);
});

test('connection epochs cannot authorize another cookie session or a disconnected sender',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa);
 assert.equal((await b.call('/api/proximity-text?connectionEpoch='+p.connectionEpoch)).status,409);
 assert.equal((await b.call('/api/proximity-text/messages','POST',f.envelope(p))).status,409);
 const pending=delayedPost(f,a,f.envelope(p));await pending.ready;await sa.close();pending.finish();assert.equal((await pending.done).status,409);assert.equal(texts(sb).length,0);
});

test('siblings joining or reconnecting while body waits cannot receive the earlier captured submission',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,b2=f.sameUser(b),sb2=await stream(t,f,b2),p=await f.context(a,sa),pending=delayedPost(f,a,f.envelope(p));await pending.ready;
 await sb2.close();const replacement=await stream(t,f,b2),b3=f.sameUser(b),sb3=await stream(t,f,b3),a2=f.sameUser(a),sa2=await stream(t,f,a2);
 pending.finish();assert.equal((await pending.done).status,201);await sb.wait(e=>e.event==='proximity-text-message');await barrier(b,sb);assert.equal(texts(replacement).length,0);assert.equal(texts(sb3).length,0);assert.equal(texts(sa2).length,0);
 const next=await a.call('/api/proximity-text/messages','POST',f.envelope(await f.context(a,sa)));assert.equal(next.status,201);for(const s of[replacement,sb3,sa2])await s.wait(e=>e.event==='proximity-text-message');
});

test('recipient sibling leave/rejoin keeps account member but invalidates only that session stay',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,b2=f.sameUser(b),sb2=await stream(t,f,b2),p=await f.context(a,sa),old=await f.context(b2,sb2),pending=delayedPost(f,a,f.envelope(p));await pending.ready;
 await b2.call('/api/rooms/other/join','POST',{});await b2.call('/api/rooms/r/join','POST',{});const next=await f.context(b2,sb2);assert.equal(next.memberId,old.memberId);assert.notEqual(next.connectionEpoch,old.connectionEpoch);
 pending.finish();assert.equal((await pending.done).status,201);await sb.wait(e=>e.event==='proximity-text-message');await barrier(b,sb);assert.equal(texts(sb2).length,0);
});

test('expired recipient session cannot inherit a live sibling account admission',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,b2=f.sameUser(b),sb2=await stream(t,f,b2),p=await f.context(a,sa),pending=delayedPost(f,a,f.envelope(p));await pending.ready;
 f.app.store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?',f.time,f.hash(b));pending.finish();assert.equal((await pending.done).status,201);await sb2.wait(e=>e.event==='proximity-text-message');assert.equal(texts(sb).length,0);
});

test('emission rechecks recipient ACL after sending its context but before its body',async t=>{
 const f=await fixture(t),a=await f.add('Owner'),b=await f.add('Member');let armed=false,changed=false;
 f.app.server.prependListener('request',(req,res)=>{if(req.url!=='/api/events'||req.headers.cookie!==b.cookie)return;const write=res.write.bind(res);res.write=(chunk,...args)=>{const result=write(chunk,...args);if(armed&&!changed&&String(chunk).startsWith('event: proximity-text-context')){changed=true;f.app.store.run('INSERT OR REPLACE INTO members(room_id,user_id,role,banned) VALUES(?,?,?,1)','r',b.user.id,'member');}return result;};});
 const sa=await stream(t,f,a),sb=await stream(t,f,b),p=await f.context(a,sa);armed=true;
 assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(p))).status,201);await sb.wait(e=>e.event==='proximity-text-context'&&e.data.contextRevision>p.contextRevision);assert.equal(changed,true);assert.equal(texts(sb).length,0);
});

test('GET/SSE contexts are ordered; refreshed receiver context precedes the matching event',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,first=await f.context(a,sa),next=await f.context(a,sa);assert(next.contextRevision>first.contextRevision);
 const current=await f.context(a,sa),before=sb.events.length;
 assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(current))).status,201);const message=await sb.wait(e=>e.event==='proximity-text-message',before),index=sb.events.indexOf(message),context=sb.events[index-1];assert.equal(context.event,'proximity-text-context');assert.equal(context.data.connectionEpoch,message.data.recipient.connectionEpoch);assert.equal(context.data.memberId,message.data.recipient.memberId);
});

test('muted sender is blocked while incoming text remains readable to that member',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams;assert.equal((await a.call('/api/rooms/r/moderate','POST',{userId:b.user.id,action:'mute'})).status,200);
 const muted=await f.context(b,sb);assert.equal(muted.canSend,false);assert.equal(muted.reason,'muted');assert.equal((await b.call('/api/proximity-text/messages','POST',f.envelope(muted))).status,403);
 assert.equal((await a.call('/api/proximity-text/messages','POST',f.envelope(await f.context(a,sa)))).status,201);await sb.wait(e=>e.event==='proximity-text-message');
});

test('wire limits allow escaped boundary Unicode and reject oversized JSON before mutation',async t=>{
 const f=await setup(t,2),a=f.clients[0],p=await f.context(a,f.streams[0]),payload=f.envelope(p,'😀'.repeat(2000)),wire=JSON.stringify(payload).replaceAll('😀','\\ud83d\\ude00');
 const accepted=await fetch(f.base+'/api/proximity-text/messages',{method:'POST',headers:{cookie:a.cookie,'content-type':'application/json'},body:wire});assert.equal(accepted.status,201);
 const rejected=await fetch(f.base+'/api/proximity-text/messages',{method:'POST',headers:{cookie:a.cookie,'content-type':'application/json'},body:JSON.stringify(f.envelope(p,'x'.repeat(33000)))});assert.equal(rejected.status,413);assert.equal((await rejected.json()).code,'PROXIMITY_TEXT_BODY_TOO_LARGE');
});

test('same-cookie tabs receive one own-account copy while the exact originating stream gets only acknowledgement',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,sibling=await stream(t,f,a),p=await f.context(a,sa),siblingContext=await f.context(a,sibling);
 assert.equal(p.memberId,siblingContext.memberId);assert.notEqual(p.connectionEpoch,siblingContext.connectionEpoch);
 const request=f.envelope(p,'same-cookie-copy'),r=await a.call('/api/proximity-text/messages','POST',request);assert.equal(r.status,201);
 const copy=await sibling.wait(e=>e.event==='proximity-text-message');await sb.wait(e=>e.event==='proximity-text-message');assert.equal(copy.data.id,r.data.message.id);assert.equal(copy.data.ownAccountCopy,true);assert.equal(copy.data.recipient.connectionEpoch,siblingContext.connectionEpoch);assert.equal(texts(sa).length,0);
 assert.equal((await a.call('/api/proximity-text/messages','POST',request)).status,200);await barrier(b,sb);assert.equal(texts(sibling).length,1);assert.equal(texts(sb).length,1);assert.equal(texts(sa).length,0);
 const reply=await a.call('/api/proximity-text/messages','POST',f.envelope(await f.context(a,sibling),'sibling-origin'));assert.equal(reply.status,201);assert.equal((await sa.wait(e=>e.event==='proximity-text-message')).data.ownAccountCopy,true);await barrier(b,sb);assert.equal(texts(sibling).length,1);
});

test('same-cookie late-open or reconnected sibling stream never inherits a captured submission',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,oldSibling=await stream(t,f,a),p=await f.context(a,sa),pending=delayedPost(f,a,f.envelope(p));await pending.ready;
 await oldSibling.close();const replacement=await stream(t,f,a),late=await stream(t,f,a);pending.finish();assert.equal((await pending.done).status,201);await sb.wait(e=>e.event==='proximity-text-message');await barrier(b,sb);assert.equal(texts(replacement).length,0);assert.equal(texts(late).length,0);assert.equal(texts(sa).length,0);
});

test('held request cannot replace sender epoch after a same-account-preserving leave/rejoin',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,a2=f.sameUser(a),sa2=await stream(t,f,a2),before=await f.context(a,sa),body=f.envelope(before),pending=delayedPost(f,a,body);await pending.ready;
 await a.call('/api/rooms/other/join','POST',{});await a.call('/api/rooms/r/join','POST',{});const after=await f.context(a,sa);assert.equal(after.memberId,before.memberId);assert.equal(after.bubbleId,before.bubbleId);assert.notEqual(after.connectionEpoch,before.connectionEpoch);
 Object.assign(body,f.envelope(after,'rebound',{requestId:body.requestId}));pending.finish();assert.equal((await pending.done).status,409);await barrier(b,sb);assert.equal(texts(sb).length,0);assert.equal(texts(sa2).length,0);
});

test('author appearance is current stored public wardrobe, unforgeable and fixed across receipt retries',async t=>{
 const f=await setup(t,2),[a,b]=f.clients,[sa,sb]=f.streams,p=await f.context(a,sa),request=f.envelope(p,'wardrobe snapshot');
 for(const extra of[{appearance:AVATAR_PRESETS[2].appearance},{author:{id:a.user.id,name:'Forged',appearance:AVATAR_PRESETS[2].appearance}}])assert.equal((await a.call('/api/proximity-text/messages','POST',{...request,...extra})).status,400);
 const pending=delayedPost(f,a,request);await pending.ready;
 const saved=await a.call('/api/me','PATCH',{name:'Saved appearance',appearance:AVATAR_PRESETS[1].appearance});assert.equal(saved.status,200);pending.finish();const first=await pending.done;assert.equal(first.status,201);
 const event=await sb.wait(e=>e.event==='proximity-text-message');assert.deepEqual(Object.keys(first.data.message.author).sort(),['appearance','id','name']);assert.deepEqual(first.data.message.author,{id:a.user.id,name:'Saved appearance',appearance:saved.data.user.appearance});assert.deepEqual(event.data.author,first.data.message.author);
 const changed=await a.call('/api/me','PATCH',{appearance:AVATAR_PRESETS[3].appearance});assert.equal(changed.status,200);assert.notDeepEqual(changed.data.user.appearance,saved.data.user.appearance);
 const retry=await a.call('/api/proximity-text/messages','POST',request);assert.equal(retry.status,200);assert.equal(retry.data.duplicate,true);assert.deepEqual(retry.data.message.author,first.data.message.author);await barrier(b,sb);assert.equal(texts(sb).length,1);
 const next=await a.call('/api/proximity-text/messages','POST',f.envelope(await f.context(a,sa),'new appearance'));assert.equal(next.status,201);assert.deepEqual(next.data.message.author.appearance,changed.data.user.appearance);
});
