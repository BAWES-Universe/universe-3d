// Actual loopback HTTP/SSE + SQLite authority and production media client.
// Only browser peer/capture APIs are synthetic; this does not prove packets/AV.
import test from 'node:test';
import {request as httpRequest} from 'node:http';
import assert from 'node:assert/strict';
import {createGameServer} from '../server/app.mjs';
import {createMediaSession} from '../src/media.js';
import {proximityFixture} from './fixtures/proximity-config.mjs';
import {deferred,mediaEnvironment,tick} from './fixtures/proximity-media-client.mjs';
const scene={version:1,theme:'garden',bounds:{width:100,depth:100},spawn:{x:0,z:0},objects:[],areas:[{id:'silent',action:'silent',x:20,z:0,width:3,depth:3},{id:'meeting',action:'meeting',x:-20,z:0,width:4,depth:4}]};
const seeds=[{id:'world',name:'World',rooms:['r','other'].map(id=>({id,name:id,scene}))}];
const until=async(predicate,label)=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw Error('Timed out: '+label);await new Promise(r=>setTimeout(r,5));}};
async function fixture(t,config=proximityFixture){
 const app=createGameServer({database:':memory:',seeds,questsEnabled:false,proximityMembershipConfig:config}),{port}=await app.listen(0),base=`http://127.0.0.1:${port}`,clients=[];
 t.after(async()=>{for(const c of clients){c.abort?.abort();c.session?.destroy();}await Promise.allSettled(clients.flatMap(c=>[c.reading,...c.work]));await app.close();});
 async function add(name,{subscribe=true}={}){
  const f=mediaEnvironment(),state={room:null,ready:true},calls=[],events=[],work=new Set();let cookie='',intercept;
  const raw=async(path,{method='GET',body,signal}={})=>{const response=await fetch(base+path,{method,signal,headers:{...(cookie?{cookie}:{}),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return{status:response.status,data:await response.json()};};
  const api=async(path,o={})=>{const call={path,...o};calls.push(call);const result=await raw(path,o);call.status=result.status;if(result.status>=400)throw Error(`${result.status}: ${result.data.code}`);return intercept?intercept(call,result.data):result.data;};
  state.user=(await api('/api/session',{method:'POST',body:{name,woka:0}})).user;state.room=(await api('/api/rooms/r/join',{method:'POST',body:{}})).room;state.position={...state.room.scene.spawn};
  const session=createMediaSession({api,getState:()=>state,env:f.env,now:f.now}),c=Object.assign(f,{state,calls,events,work,session,raw,api,cookie:()=>cookie,interceptApi(fn){intercept=fn;},scope:()=>session.snapshot().policy?.proximityMembership,async move(x,z){await api('/api/presence',{method:'POST',body:{roomId:state.room.id,x,z,moving:false}});state.position={x,z};await session.update();},async enter(id){state.room=(await api('/api/rooms/'+id+'/join',{method:'POST',body:{}})).room;state.position={...state.room.scene.spawn};await session.update();}});clients.push(c);
  if(subscribe){const abort=new AbortController(),response=await fetch(base+'/api/events',{headers:{cookie},signal:abort.signal}),reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';c.abort=abort;
   c.reading=(async()=>{try{for(;;){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const type=block.match(/^event: (.+)$/m)?.[1],json=block.match(/^data: (.+)$/m)?.[1];if(!json)continue;const data=JSON.parse(json);events.push({type,data});if(type==='media-policy')session.acceptPolicy(data);if(type==='media-signal'){const task=session.onSignal(data).finally(()=>work.delete(task));work.add(task);}}}}catch(error){if(error.name!=='AbortError')throw error;}})();
  }
  await session.update();return c;
 }
 return{app,base,clients,add};
}
const current=c=>c.instances.filter(p=>!p.closed).at(-1);
const negotiated=c=>{const p=current(c);return !!(p?.localDescription&&p?.remoteDescription);};
async function pair(t){const f=await fixture(t),a=await f.add('A'),b=await f.add('B');await a.session.setJoined(true);await b.session.setJoined(true);await until(()=>negotiated(a)&&negotiated(b),'two client SDP');return{...f,a,b};}
test('production clients negotiate scoped offers/answers/candidates over real HTTP/SSE; ordinary P2P needs no SFU adapter',async t=>{
 const{a,b}=await pair(t);assert.equal(a.scope().transport.memberCount,2);assert.equal(b.scope().transport.p2pAllowed,true);const p=current(a);p.onicecandidate({candidate:{candidate:'synthetic-candidate'}});await until(()=>current(b).calls.some(c=>c.name==='addIceCandidate'),'candidate delivery');
 for(const c of [a,b]){assert.equal(c.session.snapshot().iceTransport,'host-only');assert.equal(c.scope().transport.connectedTransport,null);assert.equal(c.scope().transport.handoffComplete,false);const sent=c.calls.filter(x=>x.path==='/api/media/signal');assert(sent.length>0);assert(sent.every(x=>x.status===200&&x.body.fromMemberId===c.scope().memberId&&x.body.mediaScope===c.scope().mediaScope));assert.equal(c.captures.length,0);}
});
test('consent withdrawal retires actual client peers while preserving bubble membership; new consent uses replacement AV scope',async t=>{
 const{a,b}=await pair(t),before=structuredClone(a.scope()),pa=current(a),pb=current(b);await a.session.toggleDevice('microphone');const track=a.session.snapshot().devices.microphone.stream.getTracks()[0];await b.session.setJoined(false);await until(()=>pa.closed&&pb.closed,'withdraw teardown');assert.equal(track.readyState,'live');assert.equal(a.scope().memberId,before.memberId);assert.equal(a.scope().bubbleId,before.bubbleId);assert.notEqual(a.scope().mediaScope,before.mediaScope);assert.equal(a.scope().conversationRecipients.length,1);await b.session.setJoined(true);await until(()=>negotiated(a)&&negotiated(b),'reconsent SDP');assert.notEqual(current(a),pa);assert.equal(a.session.snapshot().devices.microphone.status,'on');assert.equal(a.captures.length,1);
 const oldIncoming=b.events.find(e=>e.type==='media-signal').data,pc=current(b),calls=pc.calls.length;await b.session.onSignal(oldIncoming);assert.equal(pc.calls.length,calls);
});
test('all-member threshold counts media-off clients and blocks then recovers P2P without rejoining conversation',async t=>{
 const{a,b,add}=await pair(t),before=structuredClone(a.scope()),pa=current(a),pb=current(b);const off=[];for(let i=0;i<4;i++)off.push(await add('Off '+i,{subscribe:false}));await until(()=>a.scope()?.transport.memberCount===6&&pa.closed&&pb.closed,'threshold teardown');assert.equal(a.scope().bubbleId,before.bubbleId);assert.equal(a.scope().conversationRecipients.length,5);assert.equal(a.session.snapshot().peers.length,0);assert.equal(a.session.snapshot().iceTransport,null);assert.match(a.session.snapshot().transportNotice,/SFU unavailable.*6 members/);assert.equal(a.scope().transport.connectedTransport,null);assert.equal(await a.session.toggleDevice('microphone'),true);assert.equal(a.captures.length,1);
 await off[0].move(30,30);await until(()=>a.scope()?.transport.memberCount===5&&negotiated(a)&&negotiated(b),'threshold recovery');assert.equal(a.scope().bubbleId,before.bubbleId);assert.equal(a.session.snapshot().transportNotice,'');assert.equal(a.captures.length,1);assert.equal(a.session.snapshot().devices.microphone.status,'on');
});
test('admission rejoin, Silent and meeting transitions retire scoped clients and preserve legacy meeting signaling',async t=>{
 const{a,b}=await pair(t),oldMember=b.scope().memberId,pa=current(a),pb=current(b);await b.enter('other');await until(()=>pa.closed&&pb.closed,'room departure');await b.enter('r');await b.session.setJoined(true);await until(()=>negotiated(a)&&negotiated(b),'readmission SDP');assert.notEqual(b.scope().memberId,oldMember);
 const x=current(a),y=current(b);await a.move(20,0);await until(()=>x.closed&&y.closed,'Silent teardown');assert.equal(a.session.snapshot().policy.context.kind,'silent');assert.equal(a.session.snapshot().peers.length,0);await a.move(-20,0);await b.move(-20,0);await until(()=>negotiated(a)&&negotiated(b),'meeting SDP');assert.equal(a.session.snapshot().policy.context.kind,'meeting');assert.equal(a.scope(),undefined);assert.equal(a.calls.filter(c=>c.path==='/api/media/signal').at(-1).body.bubbleId,undefined);
});
test('delayed actual GET response cannot rewind newer SSE scope or reopen retired peers',async t=>{
 const{a,b}=await pair(t),old=structuredClone(a.scope()),oldPeer=current(a),got=deferred(),release=deferred();let held=false;
 a.interceptApi(async(call,data)=>{if(call.path==='/api/media'&&!held){held=true;got.resolve();await release.promise;}return data;});const pending=a.session.refreshPolicy(true);await got.promise;await b.session.setJoined(false);await until(()=>a.scope().mediaScope!==old.mediaScope&&oldPeer.closed,'newer SSE retirement');const fresh=a.scope().mediaScope;release.resolve();await pending;await tick();assert.equal(a.scope().mediaScope,fresh);assert.equal(a.session.snapshot().peers.length,0);assert.equal(oldPeer.closed,true);
});
test('delayed actual consent response cannot overwrite newer SSE scope after another member withdraws',async t=>{
 const f=await fixture(t),a=await f.add('A'),b=await f.add('B');await b.session.setJoined(true);const got=deferred(),release=deferred();let held=false,responseScope;
 a.interceptApi(async(call,data)=>{if(call.path==='/api/media/state'&&call.body.enabled&&!held){held=true;responseScope=data.proximityMembership.mediaScope;got.resolve();await release.promise;}return data;});const joining=a.session.setJoined(true);await got.promise;await b.session.setJoined(false);await until(()=>a.scope()?.mediaScope&&a.scope().mediaScope!==responseScope,'newer consent SSE');const scope=a.scope().mediaScope;release.resolve();await joining;await tick();assert.equal(a.scope().mediaScope,scope);assert.equal(a.session.snapshot().peers.length,0);assert.equal(a.captures.length,0);
});
test('delayed actual ICE response cannot restore retired authority after consent change',async t=>{
 const f=await fixture(t),a=await f.add('A'),b=await f.add('B');await b.session.setJoined(true);const got=deferred(),release=deferred();let held=false;
 a.interceptApi(async(call,data)=>{if(call.path==='/api/media/ice'&&!held){held=true;got.resolve();await release.promise;}return data;});const joining=a.session.setJoined(true);await got.promise;const old=a.scope().mediaScope;await b.session.setJoined(false);await until(()=>a.scope().mediaScope!==old,'newer ICE authority');release.resolve();await joining;await tick();assert.equal(a.session.snapshot().peers.length,0);assert.equal(a.session.snapshot().iceError,'');assert.equal(a.session.snapshot().notice,'');assert.equal(a.captures.length,0);
});
test('delayed actual consent response cannot revive own consent revoked by a newer SSE policy',async t=>{
 const f=await fixture(t),a=await f.add('A'),b=await f.add('B');await b.session.setJoined(true);const got=deferred(),release=deferred();let held=false;
 a.interceptApi(async(call,data)=>{if(call.path==='/api/media/state'&&call.body.enabled&&!held){held=true;got.resolve();await release.promise;}return data;});const joining=a.session.setJoined(true);await got.promise;await a.raw('/api/media/state',{method:'POST',body:{enabled:false,roomId:a.state.room.id,memberId:a.scope().memberId}});await until(()=>a.session.snapshot().policy?.enabled===false,'own consent SSE denial');release.resolve();assert.equal(await joining,false);await tick();assert.equal(a.session.snapshot().joined,false);assert.equal(a.session.snapshot().peers.length,0);assert.equal(a.captures.length,0);
});
for(const kind of ['microphone','camera'])test(`actual HTTP one-click ${kind} capture starts only after the session grant is current`,async t=>{
 const f=await fixture(t),a=await f.add('A'),b=await f.add('B');await b.session.setJoined(true);const got=deferred(),release=deferred();let held=false;
 a.interceptApi(async(call,data)=>{if(call.path==='/api/media/state'&&call.body.enabled&&!held){held=true;got.resolve();await release.promise;}return data;});const capture=a.session.toggleDevice(kind);await got.promise;assert.equal(a.captures.length,0);release.resolve();assert.equal(await capture,true);assert.equal(a.captures.length,1);assert.equal(a.session.snapshot().devices[kind].status,'on');assert.equal((await a.raw('/api/media')).data.enabled,true);
});
test('Leave during delayed actual enable acknowledgement is locally immediate and serializes final server opt-out',async t=>{
 const f=await fixture(t),a=await f.add('A'),b=await f.add('B');await b.session.setJoined(true);const got=deferred(),release=deferred();let held=false;
 a.interceptApi(async(call,data)=>{if(call.path==='/api/media/state'&&call.body.enabled&&!held){held=true;got.resolve();await release.promise;}return data;});const capture=a.session.toggleDevice('microphone');await got.promise;assert.equal((await a.raw('/api/media')).data.enabled,true);const leaving=a.session.setJoined(false);assert.equal(a.session.snapshot().joined,false);assert.equal(a.session.snapshot().joining,false);assert.equal(a.captures.length,0);assert.equal(a.calls.filter(c=>c.path==='/api/media/state'&&c.body.enabled===false).length,0,'disable waits for enable acknowledgement');release.resolve();assert.equal(await capture,false);await leaving;assert.equal(a.captures.length,0);assert.equal((await a.raw('/api/media')).data.enabled,false);assert.deepEqual(a.calls.filter(c=>c.path==='/api/media/state').map(c=>c.body.enabled),[true,false]);
});
test('second device click cancels capture intent while actual consent acknowledgement is delayed',async t=>{
 const f=await fixture(t),a=await f.add('A'),b=await f.add('B');await b.session.setJoined(true);const got=deferred(),release=deferred();let held=false;
 a.interceptApi(async(call,data)=>{if(call.path==='/api/media/state'&&call.body.enabled&&!held){held=true;got.resolve();await release.promise;}return data;});const capture=a.session.toggleDevice('camera');await got.promise;assert.equal(await a.session.toggleDevice('camera'),false);release.resolve();assert.equal(await capture,false);assert.equal(a.captures.length,0);assert.equal(a.session.snapshot().devices.camera.status,'off');
});

test('solo microphone becomes ready without ICE, then the same stream attaches only to a newly authorized pair',async t=>{
 const f=await fixture(t),a=await f.add('Solo');assert.equal(a.scope().bubbleId,null);assert.equal(await a.session.toggleDevice('microphone'),true);const track=a.session.snapshot().devices.microphone.stream.getTracks()[0];assert.equal(a.captures.length,1);assert.equal(a.session.snapshot().iceTransport,null);assert.equal(a.calls.some(c=>c.path==='/api/media/ice'||c.path==='/api/media/signal'),false);assert.equal(a.instances.length,0);
 const b=await f.add('Nearby');await b.session.setJoined(true);await until(()=>negotiated(a)&&negotiated(b),'solo becomes authorized pair');assert.equal(track.readyState,'live');assert.equal(a.captures.length,1);assert.equal(current(a).getTransceivers()[0].sender.track,track);assert.equal(a.scope().transport.connectedTransport,null);
 await a.move(20,0);await until(()=>track.readyState==='ended'&&a.session.snapshot().peers.length===0,'Silent stops formerly solo stream');assert.equal(a.session.snapshot().devices.microphone.status,'off');
});
test('queued Leave and rejoin cannot send old enable into a newly joined HTTP room',async t=>{
 const f=await fixture(t),a=await f.add('A'),b=await f.add('B');await b.session.setJoined(true);const got=deferred(),release=deferred();let held=false;
 a.interceptApi(async(call,data)=>{if(call.path==='/api/media/state'&&call.body.enabled&&!held){held=true;got.resolve();await release.promise;}return data;});const first=a.session.setJoined(true);await got.promise;const leave=a.session.setJoined(false),again=a.session.setJoined(true);await a.enter('other');release.resolve();await Promise.all([first,leave,again]);const policy=(await a.raw('/api/media')).data;assert.equal(policy.roomId,'other');assert.equal(policy.enabled,false);assert.equal(a.calls.filter(c=>c.path==='/api/media/state'&&c.body.enabled).length,1);assert.equal(a.session.snapshot().joined,false);assert.equal(a.captures.length,0);
});

async function delayedConsentBody(t,f,c,body){
 const payload=JSON.stringify(body),arrival=deferred(),id=Math.random().toString(36);const onRequest=req=>{if(req.headers['x-local-fixture']===id){f.app.server.off('request',onRequest);arrival.resolve();}};f.app.server.on('request',onRequest);
 let req;const response=new Promise((resolve,reject)=>{req=httpRequest(f.base+'/api/media/state',{method:'POST',headers:{cookie:c.cookie(),'content-type':'application/json','content-length':Buffer.byteLength(payload),'x-local-fixture':id}},res=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(data)}));});req.on('error',reject);});t.after(()=>{f.app.server.off('request',onRequest);req.destroy();});const split=Math.floor(payload.length/2);req.write(payload.slice(0,split));await arrival.promise;return{finish(){req.end(payload.slice(split));return response;}};
}
for(const change of ['room','admission'])test(`already-transmitted partial consent body rejects retired ${change} before media or ICE mutation`,async t=>{
 const f=await fixture(t),a=await f.add('A'),b=await f.add('B');await b.session.setJoined(true);const old=a.scope(),pending=await delayedConsentBody(t,f,a,{enabled:true,roomId:'r',memberId:old.memberId});await a.enter('other');if(change==='admission')await a.enter('r');const before=(await a.raw('/api/media')).data;assert.equal(before.enabled,false);const rejected=await pending.finish();assert.equal(rejected.status,403);assert.equal(rejected.data.code,change==='room'?'STALE_MEDIA_CONTEXT':'STALE_MEDIA_ADMISSION');const after=(await a.raw('/api/media')).data;assert.equal(after.enabled,false);assert.equal(after.iceScope,undefined);assert.deepEqual(after.peers,[]);assert.equal(a.captures.length,0);
});
test('configured consent requires room/admission preconditions, while current same-room consent succeeds',async t=>{
 const f=await fixture(t),a=await f.add('A');for(const body of [{enabled:true},{enabled:true,roomId:'r'},{enabled:true,roomId:'r',memberId:'retired'}]){assert.equal((await a.raw('/api/media/state',{method:'POST',body})).status,403);assert.equal((await a.raw('/api/media')).data.enabled,false);}assert.equal(await a.session.setJoined(true),true);assert.equal((await a.raw('/api/media')).data.enabled,true);
});
