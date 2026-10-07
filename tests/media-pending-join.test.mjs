// Controlled consent/signaling order with production session code; no devices or browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaSession} from '../src/media.js';
import {deferred,mediaEnvironment,tick,policyFixture,incomingSignal,iceResponse} from './fixtures/proximity-media-client.mjs';
const peer={id:'a',canSend:false,canReceive:true};
const offer={roomId:'r',from:'a',connectionId:'early-connection',description:{type:'offer',sdp:'synthetic-offer'}};
function fixture(t,{scoped=false,consentReply}={}) {
 const f=mediaEnvironment(),state={user:{id:'z'},room:{id:'r'},admissionId:'admission-1'},consent=deferred(),calls=[];
 let policy=scoped?policyFixture('z','a'):{selfId:'z',roomId:'r',enabled:false,context:{kind:'audience',group:'stage',canPublish:false},peers:[peer]};
 let interceptor;
 const api=async(path,options={})=>{
  calls.push({path,...options});
  const normal=()=>{
   if(path==='/api/media/state'){policy={...policy,enabled:options.body.enabled};session.acceptPolicy(structuredClone(policy));return options.body.enabled?consent.promise.then(()=>structuredClone(consentReply?consentReply(policy):policy)):structuredClone(policy);}
   if(path==='/api/media/ice')return iceResponse(policy,options.body.requestId,f.now());
   if(path==='/api/media')return structuredClone(policy);
   return {ok:true};
  };
  return interceptor?interceptor(path,options,normal):normal();
 };
 const session=createMediaSession({api,getState:()=>state,env:f.env,now:f.now});
 t.after(()=>session.destroy());
 return Object.assign(f,{state,session,consent,calls,interceptApi(fn){interceptor=fn;},getPolicy:()=>policy,push(changes){policy={...policy,...changes};session.acceptPolicy(structuredClone(policy));},signal(data){return scoped?incomingSignal(policy,{connectionId:'early-connection',...data}):{...offer,...data};}});
}
async function pending(t,options) {
 const f=fixture(t,options);await f.session.update();f.join=f.session.setJoined(true);await tick();
 assert.equal(f.session.snapshot().joining,true);assert.equal(f.session.snapshot().joined,false);assert.equal(f.getPolicy().enabled,true);return f;
}
async function drain(f,signals=[]) {f.consent.resolve();await f.join;await Promise.all(signals);await tick();}
const current=f=>f.instances.filter(pc=>!pc.closed).at(-1);
for(const scoped of [false,true])test(`authorized early offer and candidates wait for current ${scoped?'scoped':'legacy'} join grant`,async t=>{
 const f=await pending(t,{scoped});
 const signals=[f.session.onSignal(f.signal({description:undefined,candidate:{candidate:'before'}})),f.session.onSignal(f.signal({description:offer.description})),f.session.onSignal(f.signal({description:undefined,candidate:{candidate:'after'}}))];
 assert.equal(f.instances.length,0);assert.equal(f.captures.length,0);
 // Identical policy events and ordinary unjoined reconciliation must not retire pending data.
 for(let i=0;i<3;i++){f.push({});await f.session.update();}
 await drain(f,signals);const pc=current(f);
 assert.equal(f.session.snapshot().joined,true);assert.equal(pc.localDescription.type,'answer');assert.equal(pc.remoteDescription.type,'offer');
 assert.deepEqual(pc.calls.filter(call=>call.name==='addIceCandidate').map(call=>call.data.candidate),['before','after']);assert.equal(f.captures.length,0);
});
for(const change of ['cancel','room','actor','admission','unavailable','silent-aba','recipient-aba','direction-aba','consent-aba','ice-scope-aba','policy-failure'])test(`pending offer cannot survive ${change}`,async t=>{
 const f=await pending(t),signal=f.session.onSignal(offer),initial=structuredClone(f.getPolicy());let leave;
 if(change==='cancel')leave=f.session.setJoined(false);
 if(change==='room'){f.state.room={id:'other'};f.session.checkLocalPolicy();}
 if(change==='actor'){f.state.user={id:'other'};f.session.checkLocalPolicy();}
 if(change==='admission'){f.state.admissionId='admission-2';f.session.checkLocalPolicy();}
 if(change==='unavailable'){f.state.ready=false;f.session.checkLocalPolicy();}
 if(change==='silent-aba'){f.push({context:{kind:'silent',canPublish:false},peers:[]});f.push(initial);}
 if(change==='recipient-aba'){f.push({peers:[]});f.push(initial);}
 if(change==='direction-aba'){f.push({peers:[{...peer,canSend:true}]});f.push(initial);}
 if(change==='consent-aba'){f.push({enabled:false});f.push(initial);}
 if(change==='ice-scope-aba'){f.push({iceScope:'other-scope'});f.push({...initial,iceScope:initial.iceScope});}
 if(change==='policy-failure'){f.interceptApi((path,options,normal)=>path==='/api/media'?Promise.reject(Error('offline')):normal());await f.session.refreshPolicy(true);f.interceptApi(null);f.push(initial);}
 await drain(f,[signal]);await leave;assert.equal(f.instances.length,0);assert.equal(f.captures.length,0);
});
test('leave then new join never replays the old join offer',async t=>{
 const f=await pending(t),signal=f.session.onSignal(offer),leave=f.session.setJoined(false),newJoin=f.session.setJoined(true);
 f.consent.resolve();await Promise.all([f.join,leave,newJoin,signal]);assert.equal(f.instances.length,0);
 await f.session.onSignal({...offer,connectionId:'fresh-connection'});assert.equal(current(f).localDescription.type,'answer');
});
test('recipient revocation during deferred signal refresh remains retired after restoration',async t=>{
 const f=await pending(t),signal=f.session.onSignal(offer),wait=deferred(),entered=deferred();let reads=0;
 f.interceptApi((path,options,normal)=>{if(path==='/api/media'&&++reads===2){entered.resolve();return wait.promise;}return normal();});
 f.consent.resolve();await f.join;await entered.promise;const initial=structuredClone(f.getPolicy());f.push({peers:[]});f.push(initial);wait.resolve(initial);await signal;
 assert.equal(f.instances.length,0);assert.equal(f.captures.length,0);
});
test('candidate saturation is bounded separately and cannot discard the early offer',async t=>{
 const f=await pending(t),signals=[];
 for(let i=0;i<70;i++)signals.push(f.session.onSignal({...offer,description:undefined,candidate:{candidate:'candidate-'+i}}));
 signals.push(f.session.onSignal(offer));await drain(f,signals);
 assert.equal(current(f).remoteDescription.type,'offer');assert.equal(current(f).calls.filter(call=>call.name==='addIceCandidate').length,64);
});
test('offer backlog is bounded and retired pending entries release their budget',async t=>{
 const f=await pending(t),signals=[];
 for(let i=0;i<25;i++)signals.push(f.session.onSignal({...offer,connectionId:'early-'+i}));
 await drain(f,signals);assert.equal(f.instances.length,20);
 await f.session.onSignal({...offer,connectionId:'fresh-after-drain'});assert.equal(current(f).remoteDescription.type,'offer');assert.equal(f.instances.length,21);
});
test('unjoined or wrong-room/sender signals cannot create consent or capture',async t=>{
 const f=fixture(t);await f.session.update();await f.session.onSignal(offer);assert.equal(f.calls.some(call=>call.path==='/api/media/state'),false);
 f.join=f.session.setJoined(true);await tick();const signals=[{...offer,roomId:'old'},{...offer,from:'unknown'},{...offer,from:'zz'}].map(event=>f.session.onSignal(event));await drain(f,signals);
 assert.equal(f.instances.length,0);assert.equal(f.captures.length,0);
});

for(const denial of ['disabled','missing-enabled','wrong-room','wrong-self','wrong-member'])test(`pending signals require an explicit matching grant: ${denial}`,async t=>{
 const f=await pending(t,{scoped:denial==='wrong-member',consentReply:policy=>denial==='disabled'?{...policy,enabled:false}:denial==='missing-enabled'?{...policy,enabled:undefined}:denial==='wrong-room'?{...policy,roomId:'old'}:denial==='wrong-self'?{...policy,selfId:'other'}:{...policy,proximityMembership:{...policy.proximityMembership,memberId:'retired-member'}}});
 const signal=f.session.onSignal(f.signal({description:offer.description}));await drain(f,[signal]);
 assert.equal(await f.join,false);assert.equal(f.session.snapshot().joined,false);assert.equal(f.instances.length,0);assert.equal(f.captures.length,0);
});
for(const key of ['memberId','mediaScope'])test(`scoped ${key} revoke/restore retires the pending offer`,async t=>{
 const f=await pending(t,{scoped:true}),signal=f.session.onSignal(f.signal({description:offer.description})),initial=structuredClone(f.getPolicy());
 f.push({proximityMembership:{...initial.proximityMembership,[key]:'retired-scope'}});f.push(initial);await drain(f,[signal]);assert.equal(f.instances.length,0);
});
test('old grant cannot authorize a signal from a replacement own member',async t=>{
 let original;const f=await pending(t,{scoped:true,consentReply:()=>original});original=structuredClone(f.getPolicy());
 f.push({proximityMembership:{...original.proximityMembership,memberId:'replacement-member'}});
 const signal=f.session.onSignal(f.signal({description:offer.description}));await drain(f,[signal]);
 assert.equal(await f.join,false);assert.equal(f.session.snapshot().joined,false);assert.equal(f.instances.length,0);assert.equal(f.captures.length,0);
});
