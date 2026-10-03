// Controlled promises, policy authority, tracks and document events only.
// These tests never request a real device, contact an SFU, or prove OS behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaSession} from '../src/media.js';
import {mediaEnvironment,Track,Stream,deferred,tick,policyFixture,iceResponse} from './fixtures/proximity-media-client.mjs';
const awayProjection=(conversationActive=false,liveSessionActive=false)=>({protocol:'media-away-v1',source:'legacy-media-graph',conversationActive,liveSessionActive,liveSessionSupported:liveSessionActive});
function fixture(t,{mobile=true,projection=awayProjection(),scoped=false}={}) {
 const f=mediaEnvironment(),listeners=new Map(),windowListeners=new Map(),storage=new Map(),calls=[];
 const state={user:{id:'a'},room:{id:'r'},admissionId:'admission-1',ready:true};
 let policy=scoped?policyFixture():{selfId:'a',roomId:'r',enabled:false,context:{kind:'proximity',group:'proximity',canPublish:true},peers:[]};
 policy.awayPrivacy=projection;
 let intercept,capture;
 const document={visibilityState:'visible',addEventListener(type,fn){listeners.set(type,fn);},removeEventListener(type,fn){if(listeners.get(type)===fn)listeners.delete(type);}};
 Object.assign(f.env,{document,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},addEventListener:(type,fn)=>windowListeners.set(type,fn)});
 f.env.navigator.permissions={query:async()=>({state:'granted'})};
 Object.assign(f.env.navigator,mobile?{platform:'iPhone',userAgent:'iPhone'}:{platform:'MacIntel',userAgent:'Macintosh'});
 for(const method of ['getUserMedia','getDisplayMedia']){const original=f.env.navigator.mediaDevices[method];f.env.navigator.mediaDevices[method]=options=>{calls.push({capture:method,options});return capture?capture(method,options):original(options);};}
 const api=async(path,options={})=>{calls.push({path,...options});const normal=()=>{if(path==='/api/media')return structuredClone(policy);if(path==='/api/media/state'){policy.enabled=options.body.enabled;return structuredClone(policy);}if(path==='/api/media/ice')return iceResponse(policy,options.body.requestId,f.now());return {ok:true};};return intercept?intercept(path,options,normal):normal();};
 const session=createMediaSession({api,getState:()=>state,env:f.env,now:f.now});t.after(()=>session.destroy());
 return {...f,session,state,calls,listeners,windowListeners,get policy(){return policy;},get deviceCalls(){return calls.filter(c=>c.capture==='getUserMedia').length;},get screenCalls(){return calls.filter(c=>c.capture==='getDisplayMedia').length;},intercept(fn){intercept=fn;},capture(fn){capture=fn;},push(change){policy={...policy,...change};session.acceptPolicy(structuredClone(policy));},hide(){document.visibilityState='hidden';listeners.get('visibilitychange')?.();},show(){document.visibilityState='visible';listeners.get('visibilitychange')?.();},event(type){listeners.get(type)?.();windowListeners.get(type)?.();}};
}
async function settled(){await tick();await tick();}
const activeTrack=(f,kind)=>f.session.snapshot().devices[kind].stream.getTracks()[0];
test('mobile hide stops owned tracks immediately; only away-suspended mic/camera return with fresh authorization',async t=>{
 const f=fixture(t);for(const kind of ['microphone','camera','screen'])assert.equal(await f.session.toggleDevice(kind),true);
 const tracks=['microphone','camera','screen'].map(kind=>activeTrack(f,kind));f.hide();assert(tracks.every(track=>track.readyState==='ended'));assert.deepEqual(f.session.snapshot().awayPrivacy.suspended,['microphone','camera']);assert.equal(f.deviceCalls,2);assert.equal(f.screenCalls,1);
 const wait=deferred();let hold=true;f.intercept((path,options,normal)=>path==='/api/media'&&hold?wait.promise:normal());f.show();await tick();assert.equal(f.deviceCalls,2);assert.equal(f.session.snapshot().devices.microphone.status,'off');
 hold=false;wait.resolve(f.policy);await settled();assert.equal(f.deviceCalls,4);assert.equal(f.screenCalls,1);assert.equal(f.session.snapshot().devices.microphone.status,'on');assert.equal(f.session.snapshot().devices.camera.status,'on');assert.equal(f.session.snapshot().devices.screen.status,'off');
});
test('away removes tracks from owned streams as well as stopping them',async t=>{
 const f=fixture(t);f.capture(async()=>{const stream=new Stream([new Track()]);stream.removeTrack=track=>{stream.tracks=stream.tracks.filter(t=>t!==track);};return stream;});await f.session.toggleDevice('microphone');const stream=f.session.snapshot().devices.microphone.stream,track=stream.getTracks()[0];f.hide();assert.equal(track.readyState,'ended');assert.deepEqual(stream.getTracks(),[]);
});
for(const mobile of [true,false])test(`${mobile?'mobile opt-in':'desktop default'} retains an already-live microphone while away; camera stops`,async t=>{
 const f=fixture(t,{mobile});if(mobile)f.session.setKeepMicrophoneAway(true);await f.session.toggleDevice('microphone');await f.session.toggleDevice('camera');const mic=activeTrack(f,'microphone'),camera=activeTrack(f,'camera');f.hide();assert.equal(mic.readyState,'live');assert.equal(camera.readyState,'ended');assert.equal(f.session.snapshot().awayPrivacy.away,true);f.show();await settled();assert.equal(f.deviceCalls,3);assert.equal(activeTrack(f,'microphone'),mic);
});
test('visible blur, iframe/content focus, panel and keyboard events do not latch away or churn capture',async t=>{
 const f=fixture(t);await f.session.toggleDevice('microphone');const track=activeTrack(f,'microphone');for(const type of ['blur','focus','focusin','keydown','panelchange'])f.event(type);await settled();assert.equal(f.windowListeners.size,0);assert.deepEqual([...f.listeners.keys()],['visibilitychange']);assert.equal(f.session.snapshot().awayPrivacy.away,false);assert.equal(track.readyState,'live');assert.equal(f.deviceCalls,1);
});
test('authoritative conversation with zero RTC/AV peers preserves capture until its last member leaves hidden',async t=>{
 const f=fixture(t,{projection:awayProjection(true)});await f.session.toggleDevice('microphone');const track=activeTrack(f,'microphone');assert.equal(f.instances.length,0);assert.equal(f.policy.peers.length,0);f.hide();assert.equal(f.session.snapshot().awayPrivacy.away,false);assert.equal(track.readyState,'live');f.push({awayPrivacy:awayProjection()});assert.equal(f.session.snapshot().awayPrivacy.away,true);assert.equal(track.readyState,'ended');
 f.push({awayPrivacy:awayProjection(true,true)});await settled();assert.equal(f.session.snapshot().awayPrivacy.away,true);assert.equal(f.deviceCalls,1);
});
test('explicit supported live-session signal prevents entry after peers leave and its ending triggers away',async t=>{
 const f=fixture(t,{projection:awayProjection(true,true)});await f.session.toggleDevice('microphone');const track=activeTrack(f,'microphone');f.hide();f.push({awayPrivacy:awayProjection(false,true)});assert.equal(track.readyState,'live');assert.equal(f.session.snapshot().awayPrivacy.away,false);f.push({awayPrivacy:awayProjection()});assert.equal(track.readyState,'ended');assert.equal(f.session.snapshot().awayPrivacy.away,true);
});
for(const outcome of ['success','rejection'])test(`late permission ${outcome} cannot revive or replace a new away-return capture`,async t=>{
 const f=fixture(t);await f.session.setJoined(true);const waits=[deferred(),deferred()];let i=0;f.capture(()=>waits[i++].promise);const old=f.session.toggleDevice('microphone');f.hide();f.show();await settled();assert.equal(i,2);const fresh=new Track();waits[1].resolve(new Stream([fresh]));await settled();
 if(outcome==='success'){const stale=new Track();waits[0].resolve(new Stream([stale]));assert.equal(await old,false);assert.equal(stale.readyState,'ended');}else {waits[0].reject(Error('stale rejection'));assert.equal(await old,false);}
 assert.equal(activeTrack(f,'microphone'),fresh);assert.equal(fresh.readyState,'live');assert.equal(f.session.snapshot().devices.microphone.status,'on');assert.equal(f.session.snapshot().devices.microphone.error,'');
});
test('pending microphone request is fenced even when keep-mic is on; hidden never starts the device',async t=>{
 const f=fixture(t);f.session.setKeepMicrophoneAway(true);await f.session.setJoined(true);const wait=deferred();f.capture(()=>wait.promise);const pending=f.session.toggleDevice('microphone');f.hide();const track=new Track();wait.resolve(new Stream([track]));assert.equal(await pending,false);assert.equal(track.readyState,'ended');assert.equal(f.deviceCalls,1);assert.equal(f.session.snapshot().devices.microphone.status,'off');
});
for(const timing of ['hidden','return-confirmation'])test(`manual off during ${timing} cancels resumable intent`,async t=>{
 const f=fixture(t);await f.session.toggleDevice('microphone');f.hide();const wait=deferred();let held=true;f.intercept((path,o,normal)=>path==='/api/media'&&held?wait.promise:normal());if(timing==='return-confirmation')f.show();await f.session.toggleDevice('microphone');held=false;wait.resolve(f.policy);f.show();await settled();assert.equal(f.deviceCalls,1);assert.deepEqual(f.session.snapshot().awayPrivacy.suspended,[]);assert.equal(f.session.snapshot().devices.microphone.status,'off');
});
test('manually off devices and screen never auto-start; toggling keep-mic on while hidden never recaptures',async t=>{
 const f=fixture(t);await f.session.toggleDevice('microphone');await f.session.toggleDevice('microphone');await f.session.toggleDevice('screen');f.hide();f.session.setKeepMicrophoneAway(true);for(const kind of ['microphone','camera','screen'])assert.equal(await f.session.toggleDevice(kind),false);assert.equal(f.deviceCalls,1);assert.equal(f.screenCalls,1);f.show();await settled();assert.equal(f.deviceCalls,1);assert.equal(f.screenCalls,1);
});
test('turning keep-mic off while already away suspends only the existing requested microphone',async t=>{
 const f=fixture(t,{mobile:false});await f.session.toggleDevice('microphone');const track=activeTrack(f,'microphone');f.hide();assert.equal(track.readyState,'live');f.session.setKeepMicrophoneAway(false);assert.equal(track.readyState,'ended');f.show();await settled();assert.equal(f.deviceCalls,2);
});
for(const reason of ['silent','busy','revoke','room','account','admission','disconnect','context'])test(`${reason} during away cancels return capture even after ordinary recovery`,async t=>{
 const f=fixture(t);await f.session.toggleDevice('microphone');f.hide();
 if(reason==='silent'||reason==='busy')f.push({context:{kind:reason==='silent'?'silent':'proximity',group:'proximity',canPublish:false}});
 else if(reason==='revoke')f.push({enabled:false});
 else if(reason==='context')f.push({context:{kind:'meeting',group:'new-meeting',canPublish:true}});
 else {if(reason==='room')f.state.room.id='other';if(reason==='account')f.state.user.id='b';if(reason==='admission')f.state.admissionId='admission-2';if(reason==='disconnect')f.state.ready=false;f.session.checkLocalPolicy();}
 assert.deepEqual(f.session.snapshot().awayPrivacy.suspended,[]);f.state.ready=true;f.push({selfId:f.state.user.id,roomId:f.state.room.id,enabled:true,context:{kind:'proximity',group:'proximity',canPublish:true}});f.show();await f.session.refreshPolicy(true);await settled();assert.equal(f.deviceCalls,1);assert.equal(f.session.snapshot().devices.microphone.status,'off');
});
test('stable same-admission resume preserves intent; changing admission while return GET waits cancels it',async t=>{
 const f=fixture(t);await f.session.toggleDevice('microphone');f.hide();const wait=deferred();let hold=true;f.intercept((path,o,normal)=>path==='/api/media'&&hold?wait.promise:normal());f.show();f.state.admissionId='new-admission';f.session.checkLocalPolicy();hold=false;wait.resolve(f.policy);await settled();assert.equal(f.deviceCalls,1);assert.equal(f.session.snapshot().joined,false);
});
test('return requires a new GET even when an old hidden GET is pending',async t=>{
 const f=fixture(t);await f.session.toggleDevice('microphone');f.hide();const waits=[deferred(),deferred()];let index=0,hold=true;f.intercept((path,o,normal)=>path==='/api/media'&&hold?waits[index++].promise:normal());const old=f.session.refreshPolicy(true);f.show();assert.equal(index,2);waits[0].resolve(f.policy);await old;assert.equal(f.deviceCalls,1);hold=false;waits[1].resolve(f.policy);await settled();assert.equal(f.deviceCalls,2);
});
test('rapid hide/show repeats retire older return continuations without duplicate captures',async t=>{
 const f=fixture(t);await f.session.toggleDevice('microphone');f.hide();const waits=[deferred(),deferred()];let index=0,hold=true;f.intercept((path,o,normal)=>path==='/api/media'&&hold?waits[index++].promise:normal());f.show();f.hide();f.event('visibilitychange');f.show();assert.equal(index,2);waits[0].resolve(f.policy);await settled();assert.equal(f.deviceCalls,1);hold=false;waits[1].resolve(f.policy);await settled();f.event('visibilitychange');f.show();await settled();assert.equal(f.deviceCalls,2);
});
test('fresh authority denial or network failure prevents automatic recapture and consumes suspended intent',async t=>{
 for(const mode of ['denial','failure']) {const f=fixture(t);await f.session.toggleDevice('microphone');f.hide();f.intercept((path,o,normal)=>path==='/api/media'?(mode==='failure'?Promise.reject(Error('offline')):{...f.policy,context:{kind:'audience',canPublish:false}}):normal());f.show();await settled();assert.equal(f.deviceCalls,1);assert.deepEqual(f.session.snapshot().awayPrivacy.suspended,[]);f.intercept(null);await f.session.refreshPolicy(true);f.show();await settled();assert.equal(f.deviceCalls,1);}
});
test('a rejected permission on return is not retried by subsequent visibility cycles',async t=>{
 const f=fixture(t);await f.session.toggleDevice('microphone');f.hide();f.capture(async()=>{throw Object.assign(Error('denied'),{name:'NotAllowedError'});});f.show();await settled();assert.equal(f.deviceCalls,2);assert.equal(f.session.snapshot().devices.microphone.status,'error');f.hide();f.show();await settled();assert.equal(f.deviceCalls,2);
});
test('pending consent completion while hidden never recaptures; it cannot invent away-resume intent',async t=>{
 const f=fixture(t,{scoped:true,projection:awayProjection()});await f.session.refreshPolicy(true);const wait=deferred();f.intercept((path,o,normal)=>path==='/api/media/state'&&o.body.enabled?wait.promise:normal());const pending=f.session.toggleDevice('camera');f.hide();wait.resolve(f.policy);await pending;f.show();await settled();assert.equal(f.deviceCalls,0);assert.deepEqual(f.session.snapshot().awayPrivacy.suspended,[]);
});
test('destroy removes visibility subscription and late capture/return completions stay retired',async t=>{
 const f=fixture(t);await f.session.toggleDevice('microphone');f.hide();const wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());f.show();f.session.destroy();assert.equal(f.listeners.size,0);wait.resolve(f.policy);await settled();assert.equal(f.deviceCalls,1);
});

for(const state of ['denied','prompt','unavailable'])test(`browser permission ${state} while hidden cancels return without a new capture prompt`,async t=>{
 const f=fixture(t);await f.session.toggleDevice('microphone');f.hide();f.env.navigator.permissions=state==='unavailable'?undefined:{query:async()=>({state})};f.show();await settled();assert.equal(f.deviceCalls,1);assert.deepEqual(f.session.snapshot().awayPrivacy.suspended,[]);assert.match(f.session.snapshot().devices.microphone.error,/confirmation/);f.env.navigator.permissions={query:async()=>({state:'granted'})};f.hide();f.show();await settled();assert.equal(f.deviceCalls,1);
});
test('permission-check completion after manual off, hidden reentry or authority change cannot resume',async t=>{
 for(const retire of ['off','hide','admission']) {const f=fixture(t);await f.session.toggleDevice('microphone');f.hide();const wait=deferred();f.env.navigator.permissions={query:()=>wait.promise};f.show();await settled();if(retire==='off')await f.session.toggleDevice('microphone');if(retire==='hide')f.hide();if(retire==='admission'){f.state.admissionId='new';f.session.checkLocalPolicy();}wait.resolve({state:'granted'});await settled();assert.equal(f.deviceCalls,1);assert.equal(f.session.snapshot().devices.microphone.status,'off');}
});
test('pending ICE cannot open a microphone while hidden or revive cancelled return intent',async t=>{
 const f=fixture(t,{scoped:true,projection:awayProjection()});await f.session.refreshPolicy(true);const wait=deferred();let request;f.intercept((path,o,normal)=>{if(path==='/api/media/ice'){request=o.body;return wait.promise;}return normal();});const pending=f.session.toggleDevice('microphone');await settled();assert(request);f.hide();assert.equal(f.deviceCalls,0);await f.session.toggleDevice('microphone');wait.resolve(iceResponse(f.policy,request.requestId,f.now()));await pending;f.show();await settled();assert.equal(f.deviceCalls,0);
});

test('cancelling microphone during its permission check does not discard independent camera return',async t=>{
 const f=fixture(t);await f.session.toggleDevice('microphone');await f.session.toggleDevice('camera');f.hide();const wait=deferred();f.env.navigator.permissions={query:({name})=>name==='microphone'?wait.promise:Promise.resolve({state:'granted'})};f.show();await settled();await f.session.toggleDevice('microphone');wait.resolve({state:'granted'});await settled();assert.equal(f.session.snapshot().devices.microphone.status,'off');assert.equal(f.session.snapshot().devices.camera.status,'on');assert.equal(f.deviceCalls,3);
});

test('terminal access revocation ends hidden conversation immediately and never preserves return intent',async t=>{
 const f=fixture(t,{projection:awayProjection(true)});await f.session.toggleDevice('microphone');const track=activeTrack(f,'microphone');f.hide();assert.equal(f.session.snapshot().awayPrivacy.away,false);f.push({roomId:null,enabled:false,awayPrivacy:undefined});assert.equal(track.readyState,'ended');assert.equal(f.session.snapshot().awayPrivacy.away,true);assert.deepEqual(f.session.snapshot().awayPrivacy.suspended,[]);f.show();await settled();assert.equal(f.deviceCalls,1);
});
test('return authorization timeout remains bounded despite newer allowed pushes and never recaptures',async t=>{
 const f=fixture(t);await f.session.toggleDevice('microphone');f.hide();const wait=deferred();f.intercept((path,o,normal)=>path==='/api/media'?wait.promise:normal());f.show();f.push({awayPrivacy:awayProjection(true)});await f.advance(8001);await settled();assert.equal(f.deviceCalls,1);assert.deepEqual(f.session.snapshot().awayPrivacy.suspended,[]);assert.match(f.session.snapshot().policyError,/timed out/);wait.resolve(f.policy);await settled();assert.equal(f.deviceCalls,1);
});
