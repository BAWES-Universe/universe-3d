import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createNearbyTyping} from '../src/proximity-typing.js';

// Exercise the actual shell's EventSource hooks with the real typing controller.
// Component fixtures deliver hello directly and cannot catch a swallowed fan-out.
test('shell hello reaches typing after arrival authority handling and reseeds every reopened stream',async t=>{
 const source=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
 const start=source.indexOf('function connectEvents()'),end=source.indexOf('\nasync function refreshCatalog',start);
 assert(start>=0&&end>start,'The real EventSource hooks must be present');
 const streams=[],order=[];let generation=0,time=1000,refresh=false;
 const state={user:{id:'a'},room:null};
 const nearby={available:true,ready:true,connection:'connected',activeId:'stay',selectedId:'stay',selected:{endedAt:null},context:{selfId:'a',roomId:'r',connectionEpoch:'connection-1',bubbleId:'bubble',memberId:'member-a',membershipRevision:1,available:true,canSend:true,conversationRecipients:[{accountId:'b',memberId:'member-b'}],typing:{protocol:'proximity-typing-v1',enabled:true,refreshMs:2000,idleMs:10000,expiryMs:12000}}};
 const typing=createNearbyTyping({api:async()=>({}),getNearby:()=>nearby,monotonicNow:()=>time,setTimer:()=>0,clearTimer(){}});
 t.after(()=>typing.destroy());
 class Source{constructor(){this.listeners=new Map();streams.push(this);}addEventListener(type,callback){this.listeners.set(type,callback);}close(){this.closed=true;}emit(type,data){this.listeners.get(type)?.({data:JSON.stringify(data)});}}
 const ctx={state,events:null,navigating:false,pendingNearbyContext:null,pendingGroupContext:null,motion:{},path:[],groupControls:null,followMotion:{clear(){}},setOnline(){},EventSource:Source,social:{resetNearbyConnection:()=>typing.reset()},arrivalNavigation:{reset:()=>++generation,hello(){order.push('arrival');if(refresh)typing.reset();return{kind:refresh?'refresh-required':'ready'};},observe:()=>({buffered:false})},reconcileArrival:()=>{order.push('reconcile');},handleEvent:event=>{if(event.type==='hello'){order.push('hello');typing.seedClock({serverTime:event.data.serverTime,accountId:event.data.user.id});}}};
 vm.createContext(ctx);vm.runInContext(source.slice(start,end)+'\nconnectEvents();',ctx);
 const hello=()=>({user:{id:'a'},arrivalEpoch:'process',serverTime:100000+time});
 const incoming=sourceId=>({protocol:'proximity-typing-v1',roomId:'r',bubbleId:'bubble',membershipRevision:1,recipient:{connectionEpoch:nearby.context.connectionEpoch,memberId:'member-a'},sourceId,revision:1,isTyping:true,serverTime:100000+time,expiresAt:112000+time,author:{id:'b',name:'Bee'},fromMemberId:'member-b'});
 const first=streams[0];first.emit('hello',hello());assert.equal(typing.receive(incoming('before-open')),false);
 first.onopen();ctx.navigating=true;first.emit('hello',hello());assert.deepEqual(order,['arrival','hello']);assert.equal(typing.receive(incoming('initial')),true);ctx.navigating=false;
 first.onerror();assert.equal(typing.snapshot().authors.length,0);first.emit('hello',hello());assert.equal(typing.receive(incoming('disconnected')),false);
 time+=15000;first.onopen();assert.equal(typing.receive(incoming('before-reconnect-hello')),false);first.emit('hello',hello());assert.equal(typing.receive(incoming('reconnected')),true);
 // A changed process invalidates arrival authority first, then its same hello
 // must still reach consumers before asynchronous resume work starts.
 refresh=true;first.emit('hello',{...hello(),arrivalEpoch:'new-process'});assert.deepEqual(order.slice(-3),['arrival','hello','reconcile']);assert.equal(typing.receive(incoming('new-process')),true);
 vm.runInContext('connectEvents();',ctx);assert.equal(first.closed,true);first.emit('hello',hello());assert.equal(typing.receive(incoming('retired-source')),false);
 const second=streams[1];second.onopen();state.user={id:'other'};second.emit('hello',hello());assert.equal(typing.receive(incoming('switched-account')),false);
});
