import test from 'node:test';
import assert from 'node:assert/strict';
import {collectCommands,filterCommands} from '../src/command-palette.js';
const state={ready:true,user:{id:'me'},room:{id:'here'},people:[{id:'me',name:'Me'},{id:'ari',name:'Ári'},{id:'elsewhere',roomId:'another',name:'Elsewhere'}],worlds:[{name:'Moon Garden',rooms:[{id:'here',name:'Here'},{id:'next',name:'Atelier'},{id:'denied',name:'Private',canEnter:false}]}]};
test('commands include only real callbacks and accessible current state',()=>{
 const commands=collectCommands({state,actions:[{id:'build',label:'Build',enabled:false,run(){}},{id:'chat',label:'Chat',run(){}},{id:'fake',label:'Fake'}],onPerson(){},onNavigate(){}});
 assert.deepEqual(commands.map(c=>c.id),['chat','person:ari','room:next']);assert.equal(commands.find(c=>c.id==='person:ari').person,state.people[1]);assert.deepEqual(collectCommands({state:{}}),[]);
});
test('search is accent-insensitive, grouped and matches all query words',()=>{
 const commands=collectCommands({state,onPerson(){},onNavigate(){}});
 assert.deepEqual(filterCommands(commands,'ari').map(c=>c.id),['person:ari']);assert.deepEqual(filterCommands(commands,'garden atelier').map(c=>c.id),['room:next']);assert.deepEqual(filterCommands(commands,'ari','places'),[]);
});
test('walk is offered only when provided eligibility allows the actual person',()=>{
 const commands=collectCommands({state,onWalkToPerson(){},canWalkToPerson:p=>p.id==='ari'});assert.deepEqual(commands.map(c=>c.id),['walk:ari']);
});
