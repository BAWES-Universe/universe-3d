import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameServer} from '../server/app.mjs';
import {seedWorlds} from '../src/worlds.js';

async function fixture(t){
 const seeds=structuredClone(seedWorlds);seeds[0].rooms[0].scene.objects.push({id:'motion-platform',type:'table',x:0,z:0,width:2,depth:2});
 const app=createGameServer({seeds}),{port}=await app.listen(0),base=`http://127.0.0.1:${port}`;t.after(()=>app.close());
 async function client(name){let cookie='';const call=async(path,method='GET',body)=>{const result=await fetch(base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});if(result.headers.get('set-cookie'))cookie=result.headers.get('set-cookie').split(';')[0];return{status:result.status,data:await result.json()};};const guest=await call('/api/session','POST',{name});assert.equal(guest.status,201);const joined=await call('/api/rooms/commons/join','POST',{});assert.equal(joined.status,200);return{call,id:guest.data.user.id,admissionId:joined.data.arrival.admissionId,report:fields=>call('/api/presence','POST',{roomId:'commons',admissionId:joined.data.arrival.admissionId,...fields})};}
 return{app,client};
}

test('HTTP elevated presence and seated state retain admission fencing, identity, and occupied-seat validation',async t=>{
 const {app,client}=await fixture(t),a=await client('Moving peer'),b=await client('Seat peer');
 const airborne=await a.report({x:0,z:0,y:1.4,verticalVelocity:-1,grounded:false,seatId:null});assert.equal(airborne.status,200);assert.equal(airborne.data.presence.y,1.4);assert.equal(airborne.data.presence.grounded,false);
 for(const fields of [{y:-1},{y:513},{verticalVelocity:15},{grounded:'false'}]){assert.equal((await a.report(fields)).status,400);assert.equal(app.presence.get('commons:'+a.id).y,1.4);}
 assert.equal((await a.report({x:-6,z:1,y:0,verticalVelocity:0,grounded:true})).status,200);
 const seated=await a.report({seatId:'commons-chair1',x:99,z:99,y:10,moving:true});assert.equal(seated.status,200);assert.equal(seated.data.presence.seatId,'commons-chair1');assert.equal(seated.data.presence.seatHeight,.61);assert.equal(seated.data.presence.x,-6);assert.equal(seated.data.presence.z,0);assert.equal(seated.data.presence.y,0);assert.equal(seated.data.presence.moving,false);
 await b.report({x:-6,z:1,y:0,grounded:true});const occupied=await b.report({seatId:'commons-chair1'});assert.equal(occupied.status,409);assert.equal(occupied.data.error,'SEAT_OCCUPIED');assert.equal(app.presence.get('commons:'+b.id).seatId,null);
 const stand=await a.report({seatId:null,x:-6,z:1,y:0});assert.equal(stand.status,200);assert.equal(stand.data.presence.seatId,null);assert.equal(stand.data.presence.seatHeight,0);
 assert.equal((await b.report({seatId:'commons-chair1'})).status,200);
 const metadataOnly=await b.report({emote:'👋'});assert.equal(metadataOnly.status,200);assert.equal(metadataOnly.data.presence.seatId,'commons-chair1','metadata-only updates preserve pose');
 const oldTabWalk=await b.report({x:-6,z:1,moving:true});assert.equal(oldTabWalk.status,200);assert.equal(oldTabWalk.data.presence.seatId,null);assert.equal(oldTabWalk.data.presence.seatHeight,0);assert.equal(oldTabWalk.data.presence.y,0);assert.equal(oldTabWalk.data.presence.grounded,true);
 await b.report({x:0,z:0,y:1.01,grounded:true,seatId:null,verticalVelocity:0});const oldTabElevatedWalk=await b.report({x:2,z:2});assert.equal(oldTabElevatedWalk.status,200);assert.equal(oldTabElevatedWalk.data.presence.y,0);assert.equal(oldTabElevatedWalk.data.presence.verticalVelocity,0);
 const stale=await a.call('/api/presence','POST',{roomId:'commons',admissionId:'wrong-admission',y:1,grounded:false});assert.equal(stale.status,409);assert.equal(app.presence.get('commons:'+a.id).y,0);
 const moved=await a.call('/api/rooms/studio/join','POST',{mode:'travel'});assert.equal(moved.status,200);const oldRoom=await a.report({seatId:'commons-chair1',y:0});assert.notEqual(oldRoom.status,200);assert.equal(app.presence.get('studio:'+a.id).seatId,null);assert.equal(app.presence.get('studio:'+a.id).y,0);
});
