import test from 'node:test';
import assert from 'node:assert/strict';
import { createBubbleStore, expressionMode, DEFAULT_EMOTES } from '../src/express.js';
const expression=(id,kind='say',text=id)=>({id,roomId:'room',author:{id:'ari',name:'Ari'},kind,text,origin:{x:0,z:0}});
test('source bubble timing: max three independent five-second Say lines',()=>{
 let clock=1000;const model=createBubbleStore({now:()=>clock});
 for(let i=1;i<=4;i++){model.add(expression('line'+i),'room');clock+=100;}
 assert.deepEqual(model.values().map(x=>x.id),['line2','line3','line4']);
 clock=6150;model.reconcile([{id:'ari',x:0,z:0}],'room');assert.deepEqual(model.values().map(x=>x.id),['line3','line4']);
 clock=6400;model.reconcile([{id:'ari',x:0,z:0}],'room');assert.equal(model.values().length,0);
});
test('Think coexists with older lines, replaced by newest Think and cleared by movement or Say',()=>{
 const model=createBubbleStore();model.add(expression('speech'),'room');model.add(expression('thought','think'),'room');model.add(expression('new-thought','think'),'room');
 assert.deepEqual(model.values().map(x=>x.id),['speech','new-thought']);
 model.reconcile([{id:'ari',x:1,z:0}],'room');assert.deepEqual(model.values().map(x=>x.id),['speech']);
 model.add(expression('third-thought','think'),'room');model.add(expression('second-speech'),'room');assert.deepEqual(model.values().map(x=>x.id),['speech','second-speech']);
});
test('deduplication, actor presence and room isolation are enforced',()=>{
 const model=createBubbleStore();assert.equal(model.add(expression('first'),'other'),false);assert.equal(model.add(expression('first'),'room'),true);assert.equal(model.add(expression('first'),'room'),false);
 model.reconcile([],'room');assert.equal(model.values().length,0);model.add(expression('next'),'room');model.reconcile([{id:'ari',x:0,z:0}],'other');assert.equal(model.values().length,0);
});
test('thought has no invented timer, but count remains bounded',()=>{
 let clock=0;const model=createBubbleStore({now:()=>clock,maxBubbles:2});model.add(expression('thought','think'),'room');clock=86400000;model.reconcile([{id:'ari',x:0,z:0}],'room');assert.equal(model.values().length,1);
 model.add({...expression('one'),author:{id:'one'}},'room');model.add({...expression('two'),author:{id:'two'}},'room');assert.equal(model.values().length,2);
});
test('quiet area and supported availability force visible Think',()=>{
 assert.equal(expressionMode({user:{status:'busy'}},'say').kind,'think');assert.equal(expressionMode({user:{status:'away'}},'say').kind,'think');
 assert.equal(expressionMode({user:{status:'online'},position:{x:0,z:0},scene:{areas:[{x:0,z:0,width:3,depth:3,action:'silent'}]}},'say').kind,'think');
 assert.equal(expressionMode({user:{status:'online'}},'say').kind,'say');assert.equal(expressionMode({user:{status:'online'}},'think').kind,'think');
 assert.deepEqual(DEFAULT_EMOTES,['👍','❤️','😂','👏','😍','🙏']);
});
