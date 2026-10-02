import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageAssetTransport,mountImageLibraryShell} from '../src/image-library-shell.js';
import {normalizeImageAssetDraft} from '../src/image-asset-schema.js';
import {imageDefinitions} from '../src/image-asset-context.js';
import {clone} from '../src/worlds.js';
const date='2026-10-02T00:00:00.000Z';
function entry(roomId='room_a',assetId='asset_a'){
 return{schemaVersion:1,status:'active',definition:{schemaVersion:1,assetId,roomId,createdBy:'alice',createdAt:date,originKind:'upload'},version:{...normalizeImageAssetDraft({name:'Panel'},{width:64,height:64,byteLength:200,mediaType:'image/png'}),schemaVersion:1,assetId,roomId,versionId:'version_a',sequence:1,sha256:'a'.repeat(64),createdBy:'alice',createdAt:date}};
}
const scene=()=>({objects:[],areas:[],spawn:{x:0,z:3},bounds:{width:20,depth:20}});
function fixture(overrides={}, {rendererReady=true}={}){
 let props;globalThis.MutationObserver=class{observe(){}disconnect(){}};
 const root={hidden:true,contains:()=>false},state={user:{id:'alice'},ready:true,room:{id:'room_a',role:'owner',capabilities:{canEditScene:true,canBuild:true},imageDefinitions:{},scene:scene()},scene:scene()};
 const contexts=[],renderer={setImageContext:value=>contexts.push(value),setImageStateListener(){},getImageStates:()=>[]};
 const transport={list:async()=>({entries:[entry()]}),create:async()=>entry(),readImage:async()=>new Blob(['png'],{type:'image/png'}),reconcileCreate:async()=>({status:'committed',entry:entry()}),...overrides};
 const shell=mountImageLibraryShell({root,getState:()=>state,getRenderer:()=>rendererReady?renderer:null,transport,onChoose:()=>true,mountPanel:p=>{props=p;return{setOpen:value=>root.hidden=!value,attachRoom(){},refresh:()=>p.service.list({roomId:state.room.id}),dispose(){}};}});
 shell.acceptRoom();return{state,shell,contexts,service:props.service,context:props.getContext,root};
}

test('transport uses the mounted authenticated room routes and exact upload envelope',async()=>{
 const calls=[],transport=createImageAssetTransport({request:async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>({entries:[]}),blob:async()=>new Blob(['png'],{type:'image/png'})};}});
 const signal=new AbortController().signal;
 await transport.list({roomId:'room_a',query:'green fern',signal});
 const draft={name:'Fern'};await transport.create({roomId:'room_a',draft,bytes:Uint8Array.from([0,255,17]),mediaType:'image/png',operationId:'op_a',signal});
 await transport.reconcileCreate({roomId:'room_a',operationId:'op_a',signal});await transport.readImage({roomId:'room_a',assetId:'asset_a',versionId:'version_a',signal});
 assert.deepEqual(calls.map(call=>call.url),['/api/rooms/room_a/assets?query=green%20fern','/api/rooms/room_a/assets','/api/rooms/room_a/assets/operations/op_a','/api/rooms/room_a/assets/asset_a/versions/version_a/image']);
 assert.deepEqual(JSON.parse(calls[1].options.body),{draft,pngBase64:'AP8R',mediaType:'image/png',operationId:'op_a'});
 for(const {options}of calls){assert.equal(options.credentials,'same-origin');assert.equal(options.mode,'same-origin');assert.equal(options.signal,signal);assert.equal(options.cache,'no-store');}
 assert.equal(calls[1].options.headers['Content-Type'],'application/json');
});

test('HTTP errors retain uncertainty instead of falsely proving a failed commit',async()=>{
 const transport=createImageAssetTransport({request:async()=>({ok:false,status:403,json:async()=>({error:{code:'IMAGE_MANAGE_DENIED',message:'Denied'}})})});
 await assert.rejects(transport.create({roomId:'r',draft:{},bytes:new Uint8Array([1]),mediaType:'image/png',operationId:'op'}),error=>error.status===403&&error.message==='Denied'&&error.definitive!==true);
});

test('validated list/create/reconciliation entries bind the current scene without entering scene JSON',async()=>{
 const f=fixture();await f.service.list({roomId:'room_a'});assert.equal(f.state.room.imageDefinitions['asset_a:version_a'].definition.roomId,'room_a');assert.equal(imageDefinitions(f.state.scene)['asset_a:version_a'].version.name,'Panel');assert.equal(JSON.stringify(f.state.scene).includes('imageDefinitions'),false);
 const copied=clone(f.state.scene);assert.equal(imageDefinitions(copied)['asset_a:version_a'].definition.assetId,'asset_a');
 await f.service.create({roomId:'room_a'});await f.service.reconcileCreate({roomId:'room_a'});f.shell.dispose();
});

test('incoming same-room scenes preserve pinned local-draft definitions and validate before clone',async()=>{
 const f=fixture();await f.service.list({roomId:'room_a'});const room={id:'room_a',scene:scene(),imageDefinitions:{}};f.shell.prepareRoom(room);assert.equal(imageDefinitions(clone(room.scene))['asset_a:version_a'].definition.assetId,'asset_a');
 assert.throws(()=>f.shell.prepareRoom({id:'room_b',scene:scene(),imageDefinitions:{'asset_a:version_a':entry('room_a')}}));f.shell.dispose();
});

test('old room/account/authority completions cannot cache into a newer scope',async()=>{
 let release;const f=fixture({list:()=>new Promise(resolve=>release=resolve)});const pending=f.service.list({roomId:'room_a'});f.shell.suspend();f.state.user={id:'bob'};f.state.room={...f.state.room,id:'room_b',imageDefinitions:{},scene:scene()};f.state.scene=scene();f.shell.acceptRoom();release({entries:[entry()]});await pending;assert.deepEqual(f.state.room.imageDefinitions,{});assert.deepEqual(Object.keys(imageDefinitions(f.state.scene)),[]);
 const incoming={id:'room_a',scene:scene(),imageDefinitions:{}};f.shell.prepareRoom(incoming);assert.deepEqual(Object.keys(incoming.imageDefinitions),[]);f.shell.dispose();
});

test('failed-travel resume restores readable context at a new epoch; authority changes cancel panel scope',()=>{
 const f=fixture();const before=f.context();f.shell.suspend();assert.equal(f.context().capabilities.canRead,false);assert.equal(f.contexts.at(-1).canRead,false);f.shell.resume();assert.equal(f.context().capabilities.canRead,true);assert(f.context().roomEpoch>before.roomEpoch);
 const old=f.context().roomEpoch;f.state.room.capabilities.canEditScene=false;f.shell.syncAuthority();assert.equal(f.context().capabilities.canManage,false);assert(f.context().roomEpoch>old);const stable=f.context().roomEpoch;f.shell.syncAuthority();assert.equal(f.context().roomEpoch,stable);
 f.state.ready=false;f.shell.syncAuthority();assert.equal(f.contexts.at(-1).canRead,false);f.shell.dispose();
});

test('cross-account incoming scene never inherits the prior account map, even in the same room',async()=>{
 const f=fixture();await f.service.list({roomId:'room_a'});f.state.user={id:'bob'};const room={id:'room_a',scene:scene(),imageDefinitions:{}};f.shell.prepareRoom(room);assert.deepEqual(Object.keys(room.imageDefinitions),[]);f.shell.dispose();
});

test('invalid server envelope cannot poison current map',async()=>{
 const f=fixture({list:async()=>({entries:[entry('different_room')]})});await assert.rejects(f.service.list({roomId:'room_a'}));assert.deepEqual(f.state.room.imageDefinitions,{});f.shell.dispose();
});

test('capability fallback can read/manage image assets but cannot place invisible 3D objects',()=>{const f=fixture({}, {rendererReady:false});assert.equal(f.context().capabilities.canRead,true);assert.equal(f.context().capabilities.canManage,true);assert.equal(f.context().capabilities.canPlace,false);f.shell.dispose();});

test('lifecycle transport carries explicit CAS and archived-list mode without identity claims',async()=>{
 const calls=[],transport=createImageAssetTransport({request:async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>({entries:[]})};}});
 await transport.list({roomId:'room_a',status:'archived',query:'green'});
 await transport.update({roomId:'room_a',assetId:'asset_a',expectedRevision:3,metadata:{name:'Fern',description:'Green',tags:['plant']}});
 await transport.update({roomId:'room_a',assetId:'asset_a',expectedRevision:4,status:'archived'});
 assert.equal(calls[0].url,'/api/rooms/room_a/assets?query=green&status=archived');
 assert.equal(calls[1].options.method,'PATCH');assert.equal(calls[1].url,'/api/rooms/room_a/assets/asset_a');
 assert.deepEqual(JSON.parse(calls[1].options.body),{expectedRevision:3,metadata:{name:'Fern',description:'Green',tags:['plant']}});
 assert.deepEqual(JSON.parse(calls[2].options.body),{expectedRevision:4,status:'archived'});
});

test('lifecycle events update pinned envelopes and late list/room responses cannot reactivate archives',async()=>{
 const f=fixture();await f.service.list({roomId:'room_a'});
 await f.shell.refresh({assetId:'asset_a',status:'archived',revision:3,metadata:{name:'New label',description:'Saved',tags:['new']}});
 assert.equal(imageDefinitions(f.state.scene)['asset_a:version_a'].status,'archived');
 assert.equal(imageDefinitions(f.state.scene)['asset_a:version_a'].version.name,'Panel');
 const room={id:'room_a',scene:scene(),imageDefinitions:{'asset_a:version_a':{...entry(),revision:2}}};f.shell.prepareRoom(room);
 assert.equal(room.imageDefinitions['asset_a:version_a'].status,'archived');
 await f.shell.refresh({assetId:'asset_a',status:'active',revision:4,metadata:{name:'Restored',description:'',tags:[]}});
 assert.equal(imageDefinitions(f.state.scene)['asset_a:version_a'].status,'active');assert.equal(imageDefinitions(f.state.scene)['asset_a:version_a'].metadata.name,'Restored');f.shell.dispose();
});

test('metadata-free archive invalidation preserves known labels until authorized projection refresh',async()=>{
 const f=fixture();await f.service.list({roomId:'room_a'});
 await f.shell.refresh({assetId:'asset_a',status:'archived',revision:2});
 assert.equal(imageDefinitions(f.state.scene)['asset_a:version_a'].status,'archived');
 assert.equal(imageDefinitions(f.state.scene)['asset_a:version_a'].version.name,'Panel');
 const room={id:'room_a',scene:scene(),imageDefinitions:{'asset_a:version_a':{...entry(),status:'archived',revision:2,metadata:{name:'Authorized pinned label',description:'',tags:[]}}}};
 f.shell.receiveRoom(room);assert.equal(imageDefinitions(f.state.scene)['asset_a:version_a'].metadata.name,'Authorized pinned label');f.shell.dispose();
});

test('uncertain upload receipt remains reconcilable if another editor archived its durable asset',async()=>{
 const archived={...entry(),status:'archived',revision:2,metadata:{name:'Archived after upload',description:'',tags:[]}};
 const f=fixture({create:async()=>archived,reconcileCreate:async()=>({status:'committed',entry:archived})});
 assert.equal((await f.service.create({roomId:'room_a'})).status,'archived');
 const receipt=await f.service.reconcileCreate({roomId:'room_a'});assert.equal(receipt.status,'committed');assert.equal(receipt.entry.status,'archived');
 assert.equal(imageDefinitions(f.state.scene)['asset_a:version_a'].status,'archived');f.shell.dispose();
});
