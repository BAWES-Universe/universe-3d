import test from 'node:test';
import assert from 'node:assert/strict';
import {newPlaceDraft,preparePlaceDraft,suggestedSlug,runPlaceCreation,readPlaceDraft,savePlaceDraft,creationKey} from '../src/place-creation-flow.js';
const storage = () => {const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v)}};
test('Unicode names preserved; suggestions always satisfy ASCII slug contract',()=>{
 for(const name of ['مجلس الأصدقاء','東京 🌱','Café Déjà Vu','🌿','A'.repeat(120)]){
  const d=newPlaceDraft('ordinary');d.name=name;preparePlaceDraft(d);assert.equal(d.name,name);
  for(const step of d.steps){assert.match(step.body.slug,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);assert(step.body.slug.length<=64);assert.equal(step.body.name,name);}
 }
 assert.notEqual(suggestedSlug('same'),suggestedSlug('same'));
});
test('lost middle response followed by reload replays identical operation without duplicate hierarchy',async()=>{
 const s=storage(),d=newPlaceDraft('alice');d.name='مجلس';let lost=true;const records=new Map(),calls=[];
 const api=async(path,{body})=>{calls.push({path,body});const k=path+body.clientOperationId;if(!records.has(k))records.set(k,{id:String(records.size+1),body:{...body}});else assert.deepEqual(records.get(k).body,body);if(path==='/api/worlds'&&lost){lost=false;throw new Error('response lost');}return {[path.slice(5,-1)]:records.get(k)};};
 await assert.rejects(runPlaceCreation(d,{api,persist:d=>savePlaceDraft(s,d)}),/response lost/);
 const reload=readPlaceDraft(s,'alice');assert.equal(reload.steps[0].id,'1');assert.equal(reload.steps[1].id,null);
 await runPlaceCreation(reload,{api,persist:d=>savePlaceDraft(s,d)});
 assert.equal(records.size,3);assert.deepEqual(calls[1],calls[2]);assert.equal(reload.steps[2].id,'3');
 assert.equal(readPlaceDraft(s,'bob').started,false);
});
test('only definite slug rejection changes pending operation; unknown errors freeze payload',async()=>{
 const d=newPlaceDraft('alice');d.name='Same';const calls=[];let once=true;
 await runPlaceCreation(d,{persist:()=>{},api:async(path,{body})=>{calls.push({path,body});if(once){once=false;throw Object.assign(new Error('collision'),{status:409,data:{error:'SLUG_TAKEN'}});}return {[path.slice(5,-1)]:{id:path}};}});
 assert.notEqual(calls[0].body.slug,calls[1].body.slug);assert.notEqual(calls[0].body.clientOperationId,calls[1].body.clientOperationId);assert.equal(calls.length,4);
 const e=newPlaceDraft('alice');e.name='Same';preparePlaceDraft(e);const pinned=JSON.stringify(e);
 await assert.rejects(runPlaceCreation(e,{persist:()=>{},api:async()=>{throw Object.assign(new Error('reused'),{status:409,data:{error:'OPERATION_REUSED'}});}}));assert.equal(JSON.stringify(e),pinned);
});
test('unwritable or corrupt storage fails closed; account changes prevent the next POST',async()=>{
 const d=newPlaceDraft('alice');d.name='Safe';let calls=0;
 await assert.rejects(runPlaceCreation(d,{persist:()=>{throw Error('quota')},api:async()=>{calls++}}),/quota/);assert.equal(calls,0);
 const s=storage();s.setItem(creationKey('alice'),'{}');assert.throws(()=>readPlaceDraft(s,'alice'));
 let current=true;await assert.rejects(runPlaceCreation(d,{persist:()=>{},isCurrent:()=>current,api:async()=>{calls++;current=false;return {universe:{id:'created'}};}}),/account changed/);assert.equal(calls,1);
});

test('delayed definite collision after account switch preserves original receipt and sends no second POST',async()=>{
 const s=storage(),d=newPlaceDraft('alice');d.name='Delayed collision';let actor='alice',release,started;
 const pending=new Promise(resolve=>{started=resolve;});const response=new Promise((_,reject)=>{release=reject;});const calls=[];
 const running=runPlaceCreation(d,{persist:d=>savePlaceDraft(s,d),isCurrent:()=>actor==='alice',api:async(path,{body})=>{calls.push({path,body});started();return calls.length===1?response:{universe:{id:'wrong-account'}};}});
 await pending;const original=structuredClone(d),receipt=s.getItem(creationKey('alice'));actor='bob';
 release(Object.assign(new Error('collision'),{status:409,data:{error:'SLUG_TAKEN'}}));
 await assert.rejects(running,/account changed/);
 assert.equal(calls.length,1);assert.deepEqual(d,original);assert.equal(s.getItem(creationKey('alice')),receipt);assert.equal(s.getItem(creationKey('bob')),null);
 actor='alice';const retry=[];await runPlaceCreation(readPlaceDraft(s,'alice'),{persist:d=>savePlaceDraft(s,d),isCurrent:()=>actor==='alice',api:async(path,{body})=>{retry.push({path,body});return {[path.slice(5,-1)]:{id:path}};}});
 assert.deepEqual(retry[0],calls[0]);assert.equal(retry.length,3);
});
test('each POST rechecks ownership after persist and progress callbacks',async()=>{
 for(const phase of ['persist','onProgress']){
  const d=newPlaceDraft('alice');d.name='Ownership';let current=true,calls=0;
  await assert.rejects(runPlaceCreation(d,{isCurrent:()=>current,persist:()=>{if(phase==='persist')current=false;},onProgress:()=>{if(phase==='onProgress')current=false;},api:async()=>{calls++;return {universe:{id:'wrong-account'}};}}),/account changed/);
  assert.equal(calls,0,phase);
 }
});
