import test from 'node:test';
import assert from 'node:assert/strict';
import {destinationRoomsFromWorlds,readDestinationEntries,createDestinationEntryLoader} from '../src/destination-picker.js';
const entry={key:'cafe',areaId:'cafe-area',name:'Café entrance',isDefault:true};
test('authorized room labels retain universe/world/room hierarchy without network discovery',()=>{
 assert.deepEqual(destinationRoomsFromWorlds([{id:'w',name:'Town',universeId:'u',rooms:[{id:'cafe',name:'Café'}]}],[{id:'u',name:'Friends'}]),[{id:'cafe',name:'Café',label:'Friends / Town / Café'}]);
 assert.deepEqual(destinationRoomsFromWorlds(),[]);
});
test('entry projection rejects wrong room, malformed/missing/duplicate keys and preserves display name',()=>{
 assert.deepEqual(readDestinationEntries({roomId:'room',revision:4,entries:[entry]},'room'),[entry]);
 for(const value of [{roomId:'other',entries:[entry]},{roomId:'room',entries:[{...entry,key:'../secret'}]},{roomId:'room',entries:[{...entry,key:undefined}]},{roomId:'room',entries:[entry,entry]}])assert.throws(()=>readDestinationEntries(value,'room'));
});
test('entry loader uses bounded local room paths, shares only in-flight requests, and refreshes completed data',async()=>{
 const requests=[];const load=createDestinationEntryLoader({api:url=>new Promise((resolve,reject)=>requests.push({url,resolve,reject}))});
 for(const bad of ['https://example.org/private','../private','abc/entries','',undefined])await assert.rejects(load(bad));assert.equal(requests.length,0);
 const one=load('room'),same=load('room'),other=load('other');assert.equal(one,same);await Promise.resolve();assert.deepEqual(requests.map(r=>r.url),['/api/rooms/room/entries','/api/rooms/other/entries']);
 requests[1].resolve({roomId:'other',revision:2,entries:[]});requests[0].resolve({roomId:'room',revision:1,entries:[entry]});assert.deepEqual(await one,[entry]);assert.deepEqual(await other,[]);
 const fresh=load('room');await Promise.resolve();assert.equal(requests.length,3);requests[2].resolve({roomId:'room',revision:3,entries:[]});assert.deepEqual(await fresh,[]);
});
test('denied entry requests do not create a lasting catalog or poison retries',async()=>{
 let attempts=0;const load=createDestinationEntryLoader({api:async()=>{if(++attempts===1)throw Error('Room access denied');return{roomId:'room',entries:[]};}});
 await assert.rejects(load('room'),/denied/);assert.deepEqual(await load('room'),[]);assert.equal(attempts,2);
});
