import test from 'node:test';
import assert from 'node:assert/strict';
import {safeActionUrl,itemActions,materializeItemActions,createAction,validateActions} from '../src/action-schema.js';
import {scene as validateScene} from '../server/validation.mjs';
import {emptyScene} from '../src/worlds.js';

test('ordered action schema preserves all item and area fields and array order',()=>{
 const s=emptyScene();const actions=['message','link','audio','teleport'].map((type,i)=>({...createAction(type,'act-'+i),name:'Choice '+i,description:'Visitor-facing description'}));
 actions[1].mode='embed';actions[1].width=45;actions[1].closable=false;actions[2].volume=0;actions[2].loop=false;
 s.objects=[{id:'board',type:'board',name:'Guide',x:2,z:2,url:'https://example.org',target:'commons',actions}];
 s.areas=[{id:'area',name:'Zone',x:0,z:0,width:4,depth:4,action:'welcome',message:'Legacy',actions:structuredClone(actions).reverse()}];
 const saved=JSON.parse(validateScene(s));assert.deepEqual(saved,s);assert.deepEqual(saved.objects[0].actions.map(a=>a.id),['act-0','act-1','act-2','act-3']);assert.equal(saved.areas[0].actions[0].type,'teleport');
});

test('legacy normalization is nonmutating, stable, authoritative and preserves attachment metadata',()=>{
 const item={id:'old',type:'portal',target:'studio',url:'/api/rooms/commons/files/file-1',document:{id:'file-1',name:'Handbook.pdf',size:4}};const before=structuredClone(item);
 assert.deepEqual(itemActions(item).map(a=>a.id),['legacy-target','legacy-url']);assert.deepEqual(item,before);
 materializeItemActions(item);assert.deepEqual(item.document,before.document);assert.equal(item.url,before.url);assert.equal(item.target,before.target);assert.equal(itemActions(item).length,2);
 item.actions.splice(0,1);assert.equal(itemActions(item).length,1);item.actions=[];assert.deepEqual(itemActions(item),[]);assert.doesNotThrow(()=>validateActions(materializeItemActions(item),{scope:'item'}));
});

test('safe action URLs reject executable, credential, API and encoded navigation tricks',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,bad','//evil.example/path','/\\evil.example','https://u:p@example.org','https://example.org?access_token=secret','https://example.org?TOKEN=secret','/api/session','/api/rooms/r/files/f?token=x','/assets/../api/session','/assets/%2e%2e/api/session','/assets/%2fapi/session','https://example.org\n.evil'])assert.equal(safeActionUrl(url),null,url);
 assert.equal(safeActionUrl('/assets/chime.wav').kind,'asset');assert.equal(safeActionUrl('/api/rooms/r/files/f').kind,'document');assert.equal(safeActionUrl('https://example.org/guide').kind,'external');assert.equal(safeActionUrl('http://example.org/guide').protocol,'http:');
});

test('malformed and forged action fields fail; scoped IDs and deliberate item activation are required',()=>{
 const good=createAction('link','a');
 for(const action of [{...good,type:'script'},{...good,id:'../bad'},{...good,mode:'window'},{...good,width:29},{...good,width:91},{...good,closable:'false'},{...good,role:'owner'},{...good,document:{private:true}},{...good,url:'/api/rooms/r/files/f',mode:'embed'}])assert.throws(()=>validateActions([action]));
 assert.throws(()=>validateActions([good,good]));assert.throws(()=>validateActions(Array(21).fill(good)));
 assert.throws(()=>validateActions([{...createAction('audio','sound'),url:'/api/rooms/r/files/f'}]));
 assert.throws(()=>validateActions([{...good,trigger:'enter'}],{scope:'item'}));assert.doesNotThrow(()=>validateActions([{...good,trigger:'enter'}]));
 assert.throws(()=>validateActions([{...good,id:'legacy-area-link'}]));assert.doesNotThrow(()=>validateActions([{...good,id:'legacy-url'}],{scope:'item'}));
});

test('server validates object actions as strictly as area actions, without mutating legacy scenes',()=>{
 const s=emptyScene();s.objects=[{id:'x',type:'board',name:'Board',x:2,z:2,actions:[createAction('link','x')]}];
 s.objects[0].actions[0].url='https://user:password@example.org';assert.throws(()=>validateScene(s),e=>e.status===400);
 s.objects[0].actions[0].url='https://example.org';s.objects[0].actions[0].trigger='enter';assert.throws(()=>validateScene(s),e=>e.status===400);
 delete s.objects[0].actions; s.objects[0].url='/api/session';assert.throws(()=>validateScene(s),e=>e.code==='INVALID_URL');delete s.objects[0].url;
 const serialized=validateScene(s);assert.deepEqual(JSON.parse(serialized),s);assert.equal(s.objects[0].actions,undefined);
});


test('absolute same-origin URLs use identical protected download and API restrictions',()=>{
 assert.equal(safeActionUrl('https://universe.test/api/session','https://universe.test'),null);
 assert.equal(safeActionUrl('https://universe.test/api/rooms/r/files/f','https://universe.test').kind,'document');
 assert.equal(safeActionUrl('https://universe.test/assets/chime.wav','https://universe.test').kind,'asset');
 assert.equal(safeActionUrl('https://elsewhere.test/assets/chime.wav','https://universe.test').kind,'external');
 assert.equal(safeActionUrl('https://universe.test/api/rooms/r/files/f#token=secret','https://universe.test'),null);
});
