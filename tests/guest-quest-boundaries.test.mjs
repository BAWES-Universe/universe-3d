import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {createQuestService} from '../server/quests.mjs';

const scene={version:1,theme:'garden',bounds:{width:20,depth:20},spawn:{x:0,z:0},objects:[],areas:[]};
function fixture(t){
 const now=()=>1700000000000;
 const store=new Store(':memory:',[{id:'world',name:'World',rooms:[{id:'room',name:'Room',scene}]}],now);
 t.after(()=>store.close());
 const a=store.createUser('Durable A','0'),b=store.createUser('Durable B','0'),guest=store.createPublicGuest('Ephemeral guest','0');
 const active=new Set([a.id,guest.id]),presence=new Map([a,b,guest].map(u=>['room:'+u.id,{roomId:'room',userId:u.id,x:0,z:0,lastSeen:now()}]));
 const media={policy:id=>({enabled:active.has(id),context:{kind:'proximity'},peers:[...active].filter(peer=>peer!==id).map(id=>({id,canSend:true,canReceive:true}))})};
 const quests=createQuestService({store,presence,media,emitUser:()=>{},now});
 const state=()=>quests.state(a.id,'room');
 const offer=()=>state().available.find(q=>q.kind==='meet');
 const accept=def=>quests.accept(a.id,'room',{roomId:'room',definitionId:def.id,version:def.version});
 const wave=id=>quests.observeWave(id,'room','👋');
 const journal=()=>store.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'quest_%' ORDER BY name").map(({name})=>({name,rows:store.all(`SELECT * FROM ${name} ORDER BY rowid`)}));
 return{store,a,b,guest,active,presence,quests,state,offer,accept,wave,journal};
}

test('guest-only media peers neither offer durable meet quests nor create guest observations',t=>{
 const f=fixture(t),before=f.journal();
 assert.equal(f.quests.state(f.guest.id,'room').enabled,false);
 assert.doesNotThrow(()=>f.wave(f.guest.id));
 const previous=f.presence.get('room:'+f.guest.id);
 assert.doesNotThrow(()=>f.quests.observeMovement(f.guest.id,'room',previous,{...previous,x:1}));
 assert.deepEqual(f.journal(),before);
 assert.equal(f.offer(),undefined);
 assert.equal(f.store.get('SELECT COUNT(*) n FROM users WHERE id=?',f.guest.id).n,0);
});

test('a meet offer cannot be accepted after the durable peer is replaced by a guest',t=>{
 const f=fixture(t);f.active.add(f.b.id);const offer=f.offer();assert.ok(offer);
 f.active.delete(f.b.id);
 assert.throws(()=>f.accept(offer),error=>error.code==='QUEST_UNAVAILABLE');
 assert.equal(f.store.get('SELECT COUNT(*) n FROM quest_attempts').n,0);
 assert.equal(f.store.get('SELECT COUNT(*) n FROM quest_observations').n,0);
});

test('guest waves cannot fail or complete an accepted meet quest; durable reciprocity still works',t=>{
 const f=fixture(t);f.active.add(f.b.id);f.accept(f.offer());
 f.wave(f.a.id);assert.equal(f.state().tracked.progress.ownWave,true);
 f.active.delete(f.b.id);f.quests.reconcileRoom('room');
 assert.equal(f.state().tracked.available,false);
 const before=f.journal();
 assert.doesNotThrow(()=>f.wave(f.guest.id));
 assert.doesNotThrow(()=>f.wave(f.a.id));
 assert.deepEqual(f.journal(),before);
 assert.equal(f.state().stampCount,0);
 f.active.add(f.b.id);f.quests.reconcileRoom('room');
 assert.equal(f.state().tracked.progress.ownWave,false);
 assert.doesNotThrow(()=>f.wave(f.guest.id));
 f.wave(f.a.id);f.wave(f.b.id);
 assert.equal(f.state().stampCount,1);
 assert.equal(JSON.stringify(f.journal()).includes(f.guest.id),false);
 assert.equal(f.store.get('SELECT COUNT(*) n FROM users WHERE id=?',f.guest.id).n,0);
});
