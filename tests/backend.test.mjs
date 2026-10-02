import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameServer } from '../server/app.mjs';
import { seedWorlds, emptyScene } from '../src/worlds.js';

async function fixture(database=':memory:') {
  const app=createGameServer({database,seeds:seedWorlds});const {port}=await app.listen(0);const base=`http://127.0.0.1:${port}`;
  const client=()=>({cookie:'',async call(path,method='GET',body,headers={}){const r=await fetch(base+path,{method,headers:{...(this.cookie?{Cookie:this.cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))this.cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json(),headers:r.headers};}});
  const guest=async(name='Guest')=>{const c=client();const r=await c.call('/api/session','POST',{name,woka:1});assert.equal(r.status,201);c.user=r.data.user;return c;};
  return {app,base,client,guest};
}
async function joined(c,room='commons'){const r=await c.call(`/api/rooms/${room}/join`,'POST',{});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
async function stream(base,c){const abort=new AbortController();const r=await fetch(base+'/api/events',{headers:{Cookie:c.cookie},signal:abort.signal});const reader=r.body.getReader();let raw='';const events=[];const pending=(async()=>{try{for(;;){const {value,done}=await reader.read();if(done)break;raw+=new TextDecoder().decode(value);let pos;while((pos=raw.indexOf('\n\n'))>=0){const part=raw.slice(0,pos);raw=raw.slice(pos+2);const event=part.match(/^event: (.+)$/m)?.[1],data=part.match(/^data: (.+)$/m)?.[1];if(event&&data)events.push({event,data:JSON.parse(data)});}}}catch{}})();return {events,close:async()=>{abort.abort();await pending;},async wait(predicate){for(let i=0;i<100;i++){const item=events.find(predicate);if(item)return item;await new Promise(r=>setTimeout(r,10));}assert.fail('Expected SSE event did not arrive');}};}

test('opaque cookie identity, no caller override, auth and CSRF checks',async t=>{
  const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('Owner'),b=await f.guest('Other');
  assert.notEqual(a.cookie,b.cookie);assert.match(a.cookie,/universe_session=[A-Za-z0-9_-]{43}$/);
  const unauth=await f.client().call('/api/session');assert.equal(unauth.status,401);
  const r=await a.call('/api/session');assert.equal(r.data.user.id,a.user.id);
  const other=await b.call('/api/session','GET',undefined,{'X-User-Id':a.user.id,'X-Fixture-User':a.user.id});assert.equal(other.data.user.id,b.user.id);
  const origin=await a.call('/api/worlds','POST',{name:'Attack'},{Origin:'https://evil.example'});assert.equal(origin.status,403);
  const forgery=await f.client().call('/api/session','GET',undefined,{Cookie:`universe_session=${a.user.id}`});assert.equal(forgery.status,401);
  const cs=await f.client().call('/api/session','POST',{name:'Cookie'});assert.match(cs.headers.get('set-cookie'),/HttpOnly/);assert.match(cs.headers.get('set-cookie'),/SameSite=Strict/);
});

test('role enforcement, compare-and-swap, revoke and invalid scenes',async t=>{
  const f=await fixture();t.after(()=>f.app.close());const owner=await f.guest('Owner'),editor=await f.guest('Editor');const first=await joined(owner);await joined(editor);
  assert.equal(first.room.role,'owner');
  let r=await editor.call('/api/rooms/commons/scene','PUT',{revision:0,scene:first.room.scene,userId:owner.user.id});assert.equal(r.status,403);
  r=await owner.call(`/api/rooms/commons/members/${editor.user.id}`,'PUT',{role:'editor'});assert.equal(r.status,200);
  const results=await Promise.all([owner.call('/api/rooms/commons/scene','PUT',{revision:0,scene:first.room.scene}),editor.call('/api/rooms/commons/scene','PUT',{revision:0,scene:first.room.scene})]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(results.find(x=>x.status===409).data.room.revision,1);
  r=await editor.call(`/api/rooms/commons/members/${owner.user.id}`,'PUT',{role:'member'});assert.equal(r.status,403);
  await owner.call(`/api/rooms/commons/members/${editor.user.id}`,'PUT',{role:'member'});r=await editor.call('/api/rooms/commons/scene','PUT',{revision:1,scene:first.room.scene});assert.equal(r.status,403);
  const invalid=structuredClone(first.room.scene);invalid.bounds.width=-1;r=await owner.call('/api/rooms/commons/scene','PUT',{revision:1,scene:invalid});assert.equal(r.status,400);
  invalid.bounds.width=32;invalid.objects[0].url='javascript:alert(1)';r=await owner.call('/api/rooms/commons/scene','PUT',{revision:1,scene:invalid});assert.equal(r.status,400);
});

test('private hierarchy, targeted local-account invitations, ban and membership controls',async t=>{
  const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('Owner'),b=await f.guest('Visitor');
  await b.call('/api/account','POST',{username:'invited_visitor',password:'local invite test password'});
  const w=await a.call('/api/worlds','POST',{name:'Secret',public:false});const room=(await a.call('/api/rooms','POST',{name:'Private',worldId:w.data.world.id,public:false})).data.room;
  assert.equal((await b.call('/api/worlds')).data.worlds.some(x=>x.id===w.data.world.id),false);
  assert.equal((await b.call(`/api/rooms/${room.id}`)).status,404);assert.equal((await b.call(`/api/rooms/${room.id}/join`,'POST',{})).status,404);
  assert.equal((await a.call(`/api/rooms/${room.id}/invites`,'POST',{})).status,410);
  const inv=(await a.call(`/api/worlds/${w.data.world.id}/invitations`,'POST',{userId:b.user.id,role:'member'})).data.invitation;
  assert.equal((await b.call(`/api/rooms/${room.id}/join`,'POST',{})).status,404,'pending invitation grants no admission');
  assert.equal((await b.call(`/api/invitations/${inv.id}/accept`,'POST',{})).status,200);
  assert.equal((await b.call(`/api/rooms/${room.id}/join`,'POST',{})).status,200);
  assert.equal((await b.call(`/api/worlds/${w.data.world.id}/invitations`,'POST',{userId:a.user.id})).status,403);
  await a.call(`/api/rooms/${room.id}/moderate`,'POST',{userId:b.user.id,action:'ban'});
  assert.equal((await b.call(`/api/rooms/${room.id}/join`,'POST',{})).status,404);assert.equal((await b.call(`/api/rooms/${room.id}/messages`)).status,404);
  await a.call(`/api/rooms/${room.id}/moderate`,'POST',{userId:b.user.id,action:'unban'});assert.equal((await b.call(`/api/rooms/${room.id}/join`,'POST',{})).status,200);
});

test('chat edits, tombstones, reactions, muting and direct-message isolation',async t=>{
  const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('Owner'),b=await f.guest('Friend'),c=await f.guest('Stranger');await joined(a);await joined(b);
  const payload='<img src=x onerror=alert(1)> & "hello"';let r=await b.call('/api/rooms/commons/messages','POST',{text:payload});assert.equal(r.status,201);const id=r.data.message.id;assert.equal(r.data.message.text,payload);assert.match(r.headers.get('content-type'),/application\/json/);
  assert.equal((await a.call(`/api/messages/${id}`,'PATCH',{text:'Spoof'})).status,403);
  r=await b.call(`/api/messages/${id}`,'PATCH',{text:'Edited'});assert.equal(r.data.message.text,'Edited');
  r=await a.call(`/api/messages/${id}/reactions`,'POST',{emoji:'👍'});assert.deepEqual(r.data.message.reactions['👍'],[a.user.id]);r=await a.call(`/api/messages/${id}/reactions`,'POST',{emoji:'👍'});assert.equal(r.data.message.reactions['👍'],undefined);
  await a.call('/api/rooms/commons/moderate','POST',{userId:b.user.id,action:'mute'});assert.equal((await b.call('/api/rooms/commons/messages','POST',{text:'blocked'})).status,403);
  await a.call('/api/rooms/commons/moderate','POST',{userId:b.user.id,action:'unmute'});assert.equal((await b.call('/api/rooms/commons/messages','POST',{text:'allowed'})).status,201);
  assert.equal((await c.call(`/api/dm/${b.user.id}/messages`,'POST',{text:'unsolicited'})).status,403);
  r=await a.call(`/api/dm/${b.user.id}/messages`,'POST',{text:'private'});assert.equal(r.status,201);assert.equal((await b.call(`/api/dm/${a.user.id}/messages`)).data.messages[0].text,'private');assert.equal((await c.call('/api/conversations')).data.conversations.length,0);
  r=await a.call(`/api/messages/${id}`,'DELETE');assert.equal(r.data.message.deleted,true);assert.equal(r.data.message.text,'');
});

test('SSE personalized roles, room switch isolation, moderation disconnects presence',async t=>{
  const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('Owner'),b=await f.guest('Member');const first=await joined(a);await joined(b);const s=await stream(f.base,b);t.after(()=>s.close());await s.wait(e=>e.event==='hello');
  await a.call('/api/rooms/commons/scene','PUT',{revision:0,scene:first.room.scene});const ev=await s.wait(e=>e.event==='scene');assert.equal(ev.data.room.role,'guest');assert.equal(ev.data.room.capabilities.canEditScene,false);assert.equal(f.app.store.worldMembership(first.room.worldId,b.user.id),undefined);
  await joined(b,'studio');const n=s.events.length;await a.call('/api/rooms/commons/messages','POST',{text:'not for studio'});await new Promise(r=>setTimeout(r,40));assert.equal(s.events.slice(n).some(e=>e.event==='message'&&e.data.roomId==='commons'),false);
  await joined(b,'commons');await a.call('/api/rooms/commons/moderate','POST',{userId:b.user.id,action:'kick'});await s.wait(e=>e.event==='moderation'&&e.data.action==='kick');assert.equal((await b.call('/api/session')).data.currentRoomId,null);assert.equal((await a.call('/api/rooms/commons')).data.presence.some(p=>p.userId===b.user.id),false);
});

test('SQLite restart retains profiles, scene revision, local login, messages and permissions',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'universe-backend-'));t.after(()=>rm(dir,{recursive:true,force:true}));const database=join(dir,'world.sqlite');let f=await fixture(database);const a=await f.guest('Persistent'),b=await f.guest('Editor');const first=await joined(a);await joined(b);
  const account=await a.call('/api/account','POST',{username:'persistent_owner',password:'unique testing password'});assert.equal(account.status,201);
  await a.call(`/api/rooms/commons/members/${b.user.id}`,'PUT',{role:'editor'});first.room.scene.theme='persistent';await a.call('/api/rooms/commons/scene','PUT',{revision:0,scene:first.room.scene});await a.call('/api/rooms/commons/messages','POST',{text:'saved across restart'});const cookie=a.cookie;await f.app.close();
  f=await fixture(database);t.after(()=>f.app.close());const recovered=f.client();recovered.cookie=cookie;assert.equal((await recovered.call('/api/session')).data.user.id,a.user.id);const room=await recovered.call('/api/rooms/commons');assert.equal(room.data.room.revision,1);assert.equal(room.data.room.scene.theme,'persistent');assert.equal(room.data.messages[0].text,'saved across restart');assert.equal(room.data.members.find(m=>m.id===b.user.id).role,'editor');
  const login=f.client();assert.equal((await login.call('/api/login','POST',{username:'persistent_owner',password:'wrong'})).status,401);assert.equal((await login.call('/api/login','POST',{username:'persistent_owner',password:'unique testing password'})).data.user.id,a.user.id);
  await login.call('/api/logout','POST');assert.equal((await login.call('/api/session')).status,401);
});

test('server media policy enforces opt-in, quiet areas, role-directed stage and signal scope',async t=>{
  const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('Owner'),b=await f.guest('Audience'),c=await f.guest('Elsewhere');await joined(a);await joined(b);await joined(c,'studio');
  assert.equal((await a.call('/api/media')).data.peers.length,0);await a.call('/api/media/state','POST',{enabled:true});await b.call('/api/media/state','POST',{enabled:true});assert.equal((await a.call('/api/media')).data.peers[0].id,b.user.id);
  await a.call('/api/presence','POST',{roomId:'commons',x:6,z:-3,moving:false});assert.equal((await a.call('/api/media')).data.context.kind,'silent');assert.equal((await a.call('/api/media')).data.peers.length,0);
  assert.equal((await a.call('/api/media/signal','POST',{to:c.user.id,connectionId:'x',request:'offer'})).status,403);
  await joined(a,'assembly');await joined(b,'assembly');await a.call('/api/presence','POST',{roomId:'assembly',x:0,z:-7,moving:false});await b.call('/api/presence','POST',{roomId:'assembly',x:0,z:0,moving:false});await a.call('/api/media/state','POST',{enabled:true});await b.call('/api/media/state','POST',{enabled:true});
  const ap=(await a.call('/api/media')).data,bp=(await b.call('/api/media')).data;assert.equal(ap.peers[0].canSend,true);assert.equal(ap.peers[0].canReceive,false);assert.equal(bp.peers[0].canSend,false);assert.equal(bp.peers[0].canReceive,true);
  const bad=await b.call('/api/media/signal','POST',{to:a.user.id,connectionId:'x',description:{type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n'}});assert.equal(bad.status,403);
  const good=await b.call('/api/media/signal','POST',{to:a.user.id,connectionId:'x',description:{type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n'}});assert.equal(good.status,200);
  await a.call(`/api/rooms/assembly/members/${b.user.id}`,'PUT',{role:'editor'});await b.call('/api/presence','POST',{roomId:'assembly',x:3,z:-7,moving:false});assert.equal((await b.call('/api/media')).data.context.canPublish,true);await a.call(`/api/rooms/assembly/members/${b.user.id}`,'PUT',{role:'member'});assert.equal((await b.call('/api/media')).data.context.canPublish,false);
});

test('idempotent room/DM sends and lossless same-timestamp message cursor',async t=>{
  const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('Owner'),b=await f.guest('Friend');await joined(a);await joined(b);
  const first=await a.call('/api/rooms/commons/messages','POST',{text:'once',clientOperationId:'retry-1'});const retry=await a.call('/api/rooms/commons/messages','POST',{text:'once',clientOperationId:'retry-1'});assert.equal(retry.status,200);assert.equal(retry.data.message.id,first.data.message.id);assert.equal(retry.data.duplicate,true);
  assert.equal((await a.call('/api/rooms/commons/messages','POST',{text:'changed',clientOperationId:'retry-1'})).status,409);
  const dm1=await a.call(`/api/dm/${b.user.id}/messages`,'POST',{text:'private once',clientOperationId:'dm-retry'});const dm2=await a.call(`/api/dm/${b.user.id}/messages`,'POST',{text:'private once',clientOperationId:'dm-retry'});assert.equal(dm1.data.message.id,dm2.data.message.id);
  const timestamp=Date.now()+10;for(let i=0;i<101;i++)f.app.store.run('INSERT INTO messages(id,room_id,user_id,text,created_at) VALUES(?,?,?,?,?)',`tie-${i}`,'commons',a.user.id,`message ${i}`,timestamp);
  const page1=(await a.call('/api/rooms/commons/messages')).data;assert.equal(page1.messages.length,100);assert.equal(page1.hasMore,true);const page2=(await a.call('/api/rooms/commons/messages?cursor='+page1.nextCursor)).data;assert.equal(page2.messages.length,2);assert.equal(new Set([...page1.messages,...page2.messages].map(m=>m.id)).size,102);assert.equal(page2.hasMore,false);
});

test('profile status suppresses proximity, client empty emote accepted, stale signal room rejected',async t=>{
  const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('Owner'),b=await f.guest('Friend');await joined(a);await joined(b);await a.call('/api/media/state','POST',{enabled:true});await b.call('/api/media/state','POST',{enabled:true});assert.equal((await a.call('/api/media')).data.peers.length,1);
  assert.equal((await b.call('/api/presence','POST',{roomId:'commons',x:0,z:7,emote:'',direction:2})).status,200);
  await b.call('/api/me','PATCH',{status:'busy'});assert.equal((await a.call('/api/media')).data.peers.length,0);await b.call('/api/me','PATCH',{status:'online'});
  const r=await a.call('/api/media/signal','POST',{roomId:'studio',to:b.user.id,connectionId:'stale',request:'offer'});assert.equal(r.status,403);assert.equal(r.data.code,'ROOM_MISMATCH');
});

test('expired open SSE does not receive new private direct messages',async t=>{
  const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('Owner'),b=await f.guest('Friend');await joined(a);await joined(b);const s=await stream(f.base,b);t.after(()=>s.close());await s.wait(e=>e.event==='hello');
  f.app.store.run('UPDATE sessions SET expires_at=0 WHERE user_id=?',b.user.id);assert.equal((await b.call('/api/session')).status,401);await a.call(`/api/dm/${b.user.id}/messages`,'POST',{text:'expired stream must not see this'});await new Promise(r=>setTimeout(r,50));assert.equal(s.events.some(e=>e.event==='dm'),false);
});

test('bounded multi-action areas persist and reject unsafe URLs',async t=>{
  const f=await fixture();t.after(()=>f.app.close());const a=await f.guest('Owner');const initial=await joined(a);const scene=structuredClone(initial.room.scene);scene.areas[0].actions=[{id:'message-1',type:'message',message:'Hello'},{id:'audio-1',type:'audio',url:'/assets/sound.ogg',volume:0.5,loop:true}];
  const saved=await a.call('/api/rooms/commons/scene','PUT',{revision:0,scene});assert.equal(saved.status,200);assert.equal(saved.data.room.scene.areas[0].actions.length,2);
  scene.areas[0].actions[1].url='javascript:alert(1)';assert.equal((await a.call('/api/rooms/commons/scene','PUT',{revision:1,scene})).status,400);
});
