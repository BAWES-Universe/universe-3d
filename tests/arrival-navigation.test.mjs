import test from 'node:test';
import assert from 'node:assert/strict';
import {createArrivalNavigation,createArrivalEventBuffer,initialArrivalMode} from '../src/arrival-navigation.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const placement=(id='a1',revision=1,x=3,z=4,epoch='process')=>({admissionId:id,admissionEpoch:epoch,admissionRevision:revision,x,z});
const room=(id='a',revision=1)=>({id,revision,role:'owner',scene:{revision},capabilities:{canEditScene:true}});
const response=(id='a',arrival=placement(),revision=1)=>({room:room(id,revision),arrival,presence:[{id:'actor',...arrival}],members:[],bots:[]});
const failure=(status,code)=>Object.assign(Error(code),{status,data:{error:code}});
function harness(){
 const state={accountId:'actor',roomId:null,ready:false,pose:null,identity:null},requests=[],commits=[],lost=[],errors=[],settled=[],decisions=[];
 let commitFailure=null;
 const nav=createArrivalNavigation({getContext:()=>state,api:(url,options={})=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),onBegin(){},onCommit(value){commits.push(value);if(commitFailure)throw commitFailure;state.roomId=value.result.room.id;state.ready=true;apply(value.decision);},onDecision:apply,onAuthorityLost(reason){lost.push(reason);state.ready=false;state.identity=null;},onSettled:value=>settled.push(value),onError:error=>errors.push(error)});
 function apply(value){decisions.push(value);state.identity={admissionId:value.admissionId,admissionEpoch:value.admissionEpoch,admissionRevision:value.admissionRevision};if(value.kind==='adopt')state.pose={...value.pose};}
 nav.reset();nav.hello('process');
 async function next(){await tick();assert(requests.length,'Expected request');return requests.shift();}
 async function admit(id='a'){const promise=nav.navigate(id);const request=await next();request.resolve(response(id));await promise;return request;}
 return {state,requests,commits,lost,errors,settled,decisions,nav,next,admit,setCommitFailure:value=>{commitFailure=value;}};
}

test('travel sends modern mode and destination, commits exact server pose without resampling',async()=>{
 const h=harness(),sourceAction={roomId:'s',revision:9,entityType:'area',entityId:'door',actionId:'travel'};
 const work=h.nav.navigate('a',{entry:'cafe',sourceAction}),request=await h.next();
 assert.deepEqual(request.options,{method:'POST',body:{mode:'travel',entry:'cafe',sourceAction},deferRoomPreparation:true});
 request.resolve(response('a',placement('a2',2,-7.137,2.981)));assert.equal(await work,true);
 assert.deepEqual(h.state.pose,{x:-7.137,z:2.981});assert.equal(h.state.identity.admissionId,'a2');
});

test('same-admission resume retains live motion and sends no named entry or source action',async()=>{
 const h=harness();await h.admit();h.state.pose={x:13,z:-2};const promise=h.nav.navigate('a',{mode:'resume',entry:'cafe'}),request=await h.next();
 assert.deepEqual(request.options.body,{mode:'resume'});request.resolve(response());await promise;
 assert.equal(h.commits.at(-1).decision.kind,'retain');assert.equal('pose' in h.commits.at(-1).decision,false);assert.deepEqual(h.state.pose,{x:13,z:-2});
});

test('pending destination self presence uses newer admission revision and complete pose',async()=>{
 const h=harness();await h.admit();const promise=h.nav.navigate('b'),request=await h.next();
 const newer=placement('b3',3,-2,8);assert.equal(h.nav.observe({type:'presence',data:{roomId:'b',presence:[{id:'actor',...newer}]}}).buffered,true);
 request.resolve(response('b',placement('b2',2,7,1)));await promise;
 assert.deepEqual(h.state.pose,{x:-2,z:8});assert.equal(h.state.identity.admissionId,'b3');
});

test('target scene and role events supersede a held older room before its only commit',async()=>{
 const h=harness();const promise=h.nav.navigate('a'),request=await h.next();
 h.nav.observe({type:'scene',data:{roomId:'a',room:room('a',6)}});
 h.nav.observe({type:'scene',data:{roomId:'a',room:room('a',3)}});
 h.nav.observe({type:'role',data:{roomId:'a',role:'member',capabilities:{canEditScene:false}}});
 request.resolve(response());await promise;assert.equal(h.commits.length,1);assert.equal(h.commits[0].result.room.revision,6);assert.equal(h.commits[0].result.room.scene.revision,6);assert.equal(h.commits[0].result.room.capabilities.canEditScene,false);
});

for(const event of [{type:'access-revoked',data:{roomId:'b',reason:'membership-ended'}},{type:'moderation',data:{roomId:'b',action:'kick',userId:'actor'}},{type:'moderation',data:{roomId:'b',action:'deleted'}}])test('held target '+event.type+' '+(event.data.action??'')+' never becomes displayed authority',async()=>{
 const h=harness();await h.admit();const promise=h.nav.navigate('b');const rejection=assert.rejects(promise,/access/);const request=await h.next();h.nav.observe(event);request.resolve(response('b',placement('b2',2)));
 const leave=await h.next();assert.equal(leave.url,'/api/rooms/b/leave');assert.deepEqual(leave.options.body,{admissionId:'b2',admissionEpoch:'process',admissionRevision:2});leave.resolve({ok:true,applied:false,reason:'placement-changed'});
 const session=await h.next();assert.equal(session.url,'/api/session');session.resolve({user:{id:'actor'},currentRoomId:null});await rejection;
 assert.equal(h.commits.length,1);assert.equal(h.state.ready,false);
});

test('definite precommit denial preserves source placement and never leaves or repeats travel',async()=>{
 const h=harness();await h.admit();h.state.pose={x:7,z:8};const promise=h.nav.navigate('b'),rejection=assert.rejects(promise,/NO_ACCESS/),request=await h.next();request.reject(failure(403,'NO_ACCESS'));await rejection;
 assert.equal(h.state.roomId,'a');assert.equal(h.state.ready,true);assert.deepEqual(h.state.pose,{x:7,z:8});assert.equal(h.requests.length,0);
});

test('unknown POST outcome reads actual session then resumes changed room without repeating travel',async()=>{
 const h=harness();await h.admit();const promise=h.nav.navigate('b'),request=await h.next();request.reject(Error('response lost'));
 const session=await h.next();assert.equal(session.url,'/api/session');session.resolve({user:{id:'actor'},currentRoomId:'c'});
 const resume=await h.next();assert.equal(resume.url,'/api/rooms/c/join');assert.deepEqual(resume.options.body,{mode:'resume'});resume.resolve(response('c',placement('c3',3)));assert.equal(await promise,true);assert.equal(h.state.roomId,'c');assert.equal(h.requests.length,0);
});

test('resume race rereads authority and cannot pull a sibling back into a prior room',async()=>{
 const h=harness();await h.admit();const promise=h.nav.navigate('a',{mode:'resume',reconcile:true});
 (await h.next()).resolve({user:{id:'actor'},currentRoomId:'a'});const old=await h.next();assert.deepEqual(old.options.body,{mode:'resume'});old.reject(failure(409,'RESUME_CONTEXT_CHANGED'));
 (await h.next()).resolve({user:{id:'actor'},currentRoomId:'b'});const fresh=await h.next();assert.equal(fresh.url,'/api/rooms/b/join');fresh.resolve(response('b',placement('b2',2)));await promise;assert.equal(h.state.roomId,'b');
});

test('reconnect without a current session room retires admission without replaying travel',async()=>{
 const h=harness();await h.admit();const promise=h.nav.navigate('a',{mode:'resume',reconcile:true});
 const session=await h.next();assert.equal(session.url,'/api/session');session.resolve({user:{id:'actor'},currentRoomId:null});
 assert.equal(await promise,false);assert.equal(h.state.ready,false);assert.equal(h.state.identity,null);
 assert.deepEqual(h.lost,['no-current-room']);assert.equal(h.nav.snapshot().needsAuthority,true);assert.equal(h.requests.length,0);
});

for(const status of [403,404,410])test(`definitive ${status} on fresh reconnect resume retires source access without an old revocation event`,async()=>{
 const h=harness();await h.admit();const promise=h.nav.navigate('a',{mode:'resume',reconcile:true}),rejection=assert.rejects(promise,/ROOM_ACCESS_ENDED/);
 (await h.next()).resolve({user:{id:'actor'},currentRoomId:'a'});
 const resume=await h.next();assert.equal(resume.url,'/api/rooms/a/join');assert.deepEqual(resume.options.body,{mode:'resume'});resume.reject(failure(status,'ROOM_ACCESS_ENDED'));
 await rejection;assert.equal(h.state.ready,false);assert.equal(h.state.identity,null);assert.deepEqual(h.lost,['source-access-changed']);assert.equal(h.nav.snapshot().needsAuthority,true);assert.equal(h.requests.length,0);
});

test('temporary reconnect failure does not report revoked access and a fresh resume preserves admission',async()=>{
 const h=harness();await h.admit();h.state.pose={x:7,z:8};const promise=h.nav.navigate('a',{mode:'resume',reconcile:true});
 (await h.next()).resolve({user:{id:'actor'},currentRoomId:'a'});(await h.next()).reject(failure(503,'TEMPORARY'));
 (await h.next()).resolve({user:{id:'actor'},currentRoomId:'a'});(await h.next()).resolve(response());
 assert.equal(await promise,true);assert.deepEqual(h.lost,[]);assert.equal(h.state.ready,true);assert.deepEqual(h.state.pose,{x:7,z:8});assert.equal(h.commits.at(-1).decision.kind,'retain');
});

test('repeated identical intent shares one POST; newer queued intent supersedes intermediate queued travel',async()=>{
 const h=harness();await h.admit();const first=h.nav.navigate('b',{entry:'cafe'}),firstDuplicate=h.nav.navigate('b',{entry:'cafe'});assert.equal(first,firstDuplicate);const request=await h.next();
 const middle=h.nav.navigate('c'),last=h.nav.navigate('d');request.resolve(response('b',placement('b2',2)));
 const leave=await h.next();assert.equal(leave.url,'/api/rooms/b/leave');leave.resolve({ok:true,applied:true});assert.equal(await first,false);assert.equal(await middle,false);
 const newest=await h.next();assert.equal(newest.url,'/api/rooms/d/join');newest.resolve(response('d',placement('d3',3)));await last;assert.deepEqual(h.commits.map(value=>value.result.room.id),['a','d']);
});

test('superseded committed travel followed by failure cannot restore the retired displayed source',async()=>{
 const h=harness();await h.admit();const first=h.nav.navigate('b'),request=await h.next(),second=h.nav.navigate('c'),rejection=assert.rejects(second,/NO_ACCESS/);
 request.resolve(response('b',placement('b2',2)));(await h.next()).resolve({ok:true,applied:false,reason:'placement-changed'});await first;
 (await h.next()).reject(failure(403,'NO_ACCESS'));const session=await h.next();assert.equal(session.url,'/api/session');session.resolve({user:{id:'actor'},currentRoomId:'d'});
 const resume=await h.next();assert.equal(resume.url,'/api/rooms/d/join');resume.resolve(response('d',placement('d4',4)));await rejection;assert.equal(h.state.roomId,'d');assert.equal(h.state.ready,true);
});

test('failure while presenting committed admission conditionally leaves it and never revives source',async()=>{
 const h=harness();await h.admit();h.setCommitFailure(Error('renderer failed'));const promise=h.nav.navigate('b'),rejection=assert.rejects(promise,/renderer/);(await h.next()).resolve(response('b',placement('b2',2)));
 const leave=await h.next();assert.equal(leave.url,'/api/rooms/b/leave');assert.deepEqual(leave.options.body,{admissionId:'b2',admissionEpoch:'process',admissionRevision:2});leave.resolve({ok:true,applied:true});(await h.next()).resolve({user:{id:'actor'},currentRoomId:null});await rejection;assert.equal(h.state.ready,false);
});

test('account and EventSource reset fence pending HTTP and all target scene effects',async()=>{
 for(const accountChange of [false,true]){
  const h=harness();const promise=h.nav.navigate('a'),request=await h.next();if(accountChange)h.state.accountId='other';h.nav.reset();request.resolve(response());assert.equal(await promise,false);assert.equal(h.commits.length,0);assert.equal(h.requests.length,0);
 }
});

test('process epoch boundary demands fresh session/resume before rendering held result',async()=>{
 const h=harness();const promise=h.nav.navigate('a'),request=await h.next();h.nav.hello('new-process');request.resolve(response('a',placement('new1',1,9,9,'new-process')));
 (await h.next()).resolve({user:{id:'actor'},currentRoomId:'a'});const resume=await h.next();assert.deepEqual(resume.options.body,{mode:'resume'});assert.equal(h.commits.length,0);resume.resolve(response('a',placement('new1',1,9,9,'new-process')));await promise;assert.equal(h.commits.length,1);assert.equal(h.state.identity.admissionEpoch,'new-process');
});

test('target event storage stays bounded and unrelated actor moderation cannot revoke admission',()=>{
 const buffer=createArrivalEventBuffer('a','actor');for(let i=0;i<3000;i++)buffer.observe({type:'scene',data:{roomId:'a',room:room('a',i)}});buffer.observe({type:'moderation',data:{roomId:'a',action:'kick',userId:'other'}});assert.equal(buffer.snapshot().denied,null);assert.equal(buffer.snapshot().events.length,2);assert.equal(buffer.merge(response()).room.revision,2999);assert.equal(buffer.observe({type:'scene',data:{roomId:'b',room:room('b')}}),false);
});

test('denied same-room travel cannot hide a buffered source revocation behind retain',async()=>{
 const h=harness();await h.admit();const promise=h.nav.navigate('a',{entry:'stage'}),rejection=assert.rejects(promise,/NO_ACCESS/),request=await h.next();
 assert.equal(h.nav.observe({type:'access-revoked',data:{roomId:'a'}}).buffered,true);request.reject(failure(403,'NO_ACCESS'));
 const session=await h.next();assert.equal(session.url,'/api/session');session.resolve({user:{id:'actor'},currentRoomId:null});await rejection;assert.equal(h.state.ready,false);assert.equal(h.nav.snapshot().needsAuthority,true);
});

test('definite same-room failure replays buffered source scene and permission events',async()=>{
 const calls=[],events=[],state={accountId:'actor',roomId:'a'},nav=createArrivalNavigation({getContext:()=>state,api:()=>new Promise((resolve,reject)=>calls.push({resolve,reject})),onRetained:value=>events.push(...value)});nav.reset();nav.hello('process');
 const initial=nav.navigate('a');await tick();calls.shift().resolve(response());await initial;
 const failed=nav.navigate('a',{entry:'stage'}),rejection=assert.rejects(failed,/DENIED/);await tick();nav.observe({type:'scene',data:{roomId:'a',room:room('a',5)}});nav.observe({type:'role',data:{roomId:'a',role:'member',capabilities:{canEditScene:false}}});calls.shift().reject(failure(403,'DENIED'));await rejection;
 assert.deepEqual(events.map(value=>value.type),['scene','role']);assert.equal(events[0].data.room.revision,5);assert.equal(events[1].data.capabilities.canEditScene,false);
});

test('unexpected self-room SSE after destination commit fences held room and reconciles session',async()=>{
 const h=harness();await h.admit();const promise=h.nav.navigate('b'),request=await h.next();
 h.nav.observe({type:'presence',data:{roomId:'b',presence:[{id:'actor',...placement('b2',2)}]}});
 h.nav.observe({type:'presence',data:{roomId:'c',presence:[{id:'actor',...placement('c3',3)}]}});
 request.resolve(response('b',placement('b2',2)));const session=await h.next();assert.equal(session.url,'/api/session');assert.deepEqual(h.commits.map(value=>value.result.room.id),['a']);session.resolve({user:{id:'actor'},currentRoomId:'c'});
 const resume=await h.next();assert.equal(resume.url,'/api/rooms/c/join');assert.deepEqual(resume.options.body,{mode:'resume'});resume.resolve(response('c',placement('c3',3)));await promise;assert.equal(h.state.roomId,'c');assert.deepEqual(h.commits.map(value=>value.result.room.id),['a','c']);
});

test('live unexpected self-room SSE requests reconciliation without granting that room',async()=>{
 const h=harness();await h.admit();const observed=h.nav.observe({type:'presence',data:{roomId:'b',presence:[{id:'actor',...placement('b2',2)}]}});assert.equal(observed.decision.kind,'refresh-required');assert.equal(h.state.ready,false);assert.equal(h.state.roomId,'a');assert.equal(h.nav.snapshot().needsAuthority,true);
});

test('self source-room evidence after target publication also fences a travel back to the source',async()=>{
 const h=harness();await h.admit();const promise=h.nav.navigate('b'),request=await h.next();
 h.nav.observe({type:'presence',data:{roomId:'b',presence:[{id:'actor',...placement('b2',2)}]}});
 h.nav.observe({type:'presence',data:{roomId:'a',presence:[{id:'actor',...placement('a3',3)}]}});
 request.resolve(response('b',placement('b2',2)));(await h.next()).resolve({user:{id:'actor'},currentRoomId:'a'});(await h.next()).resolve(response('a',placement('a3',3)));await promise;assert.equal(h.state.identity.admissionId,'a3');assert.deepEqual(h.commits.map(value=>value.result.room.id),['a','a']);
});

test('unexpected self-room evidence also reconciles after a definite rejected travel',async()=>{
 const h=harness();await h.admit();const promise=h.nav.navigate('b'),request=await h.next();h.nav.observe({type:'presence',data:{roomId:'c',presence:[{id:'actor',...placement('c3',3)}]}});request.reject(failure(403,'ROOM_FORBIDDEN'));
 const session=await h.next();assert.equal(session.url,'/api/session');session.resolve({user:{id:'actor'},currentRoomId:'c'});const resume=await h.next();assert.equal(resume.url,'/api/rooms/c/join');resume.resolve(response('c',placement('c3',3)));await promise;assert.equal(h.state.roomId,'c');assert.equal(h.state.ready,true);
});


test('only initial plain admission uses enter; explicit entries and invitations travel and reloads resume',()=>{
 assert.equal(initialArrivalMode({roomId:'a'},null),'enter');
 assert.equal(initialArrivalMode({roomId:'a'},'b'),'enter');
 assert.equal(initialArrivalMode({roomId:'a',entry:'cafe'},null),'travel');
 assert.equal(initialArrivalMode({roomId:'a',entry:'cafe'},'b'),'travel');
 assert.equal(initialArrivalMode({roomId:'a',invite:'invitation'},null),'travel');
 assert.equal(initialArrivalMode({roomId:'a',invite:'invitation'},'a'),'travel');
 assert.equal(initialArrivalMode({roomId:'a'},'a'),'resume');
 assert.equal(initialArrivalMode({roomId:'a',entry:'cafe'},'a'),'resume');
});

test('initial enter forwards modern enter mode and consumes the preserved server identity and pose',async()=>{
 const h=harness(),promise=h.nav.navigate('a',{mode:'enter'}),request=await h.next();assert.deepEqual(request.options.body,{mode:'enter'});
 request.resolve(response('a',placement('existing-sibling',4,-7.125,3.25)));await promise;assert.equal(h.state.identity.admissionId,'existing-sibling');assert.deepEqual(h.state.pose,{x:-7.125,z:3.25});
 // A later ordinary app/history navigation still explicitly travels.
 const direct=h.nav.navigate('a'),next=await h.next();assert.deepEqual(next.options.body,{mode:'travel'});next.resolve(response('a',placement('explicit-travel',5,6,7)));await direct;assert.equal(h.state.identity.admissionId,'explicit-travel');
});

test('ordinary same-room reconciliation retains admission without first retiring its authority',async()=>{
 const h=harness();await h.admit();h.state.pose={x:11,z:-3};const promise=h.nav.navigate('a',{mode:'resume',reconcile:true});
 const session=await h.next();assert.equal(h.state.ready,true);assert.deepEqual(h.lost,[]);session.resolve({user:{id:'actor'},currentRoomId:'a'});
 const resume=await h.next();assert.equal(h.state.ready,true);assert.deepEqual(h.lost,[]);resume.resolve(response());await promise;
 assert.equal(h.commits.at(-1).decision.kind,'retain');assert.deepEqual(h.state.pose,{x:11,z:-3});assert.deepEqual(h.lost,[]);
});


for(const stage of ['session','resume'])test(`authentication loss during ${stage} reconciliation immediately retires source authority`,async()=>{
 const h=harness();await h.admit();const promise=h.nav.navigate('a',{mode:'resume',reconcile:true}),rejection=assert.rejects(promise,/AUTH_REQUIRED/);
 const session=await h.next();if(stage==='session')session.reject(failure(401,'AUTH_REQUIRED'));else{session.resolve({user:{id:'actor'},currentRoomId:'a'});(await h.next()).reject(failure(401,'AUTH_REQUIRED'));}
 await rejection;assert.equal(h.state.ready,false);assert.equal(h.state.identity,null);assert.equal(h.nav.snapshot().needsAuthority,true);assert(h.lost.includes('authentication-required'));assert.equal(h.commits.length,1);assert.equal(h.requests.length,0);
});
