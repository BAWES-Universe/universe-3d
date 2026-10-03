// Pure deterministic device/storage/visibility fixtures; no physical device proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {AWAY_MIC_KEYS,createAwayMicrophonePreference,isMobileMediaDevice,createAwayLatch,readAwayConversation} from '../src/media-away.js';
const storage = (values={}) => {const data=new Map(Object.entries(values));return {data,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};};
const environments = [
 ['iPhone',{navigator:{platform:'iPhone',userAgent:'iPhone'}}],
 ['iPad',{navigator:{platform:'iPad',userAgent:'iPad'}}],
 ['iPad desktop user agent',{navigator:{platform:'MacIntel',userAgent:'Mozilla Macintosh'},ontouchend:null}],
 ['iPod simulator',{navigator:{platform:'iPod Simulator',userAgent:'iPod'}}],
 ['Android',{navigator:{platform:'Linux',userAgent:'Mozilla Android'}}]
];
for (const [name,env] of environments) test(`${name} gets independent OFF default and ignores historical desktop/shared value`,()=>{
 for(const desktop of [undefined,'true','false']) {
  const localStorage=storage(desktop===undefined?{}:{[AWAY_MIC_KEYS.desktop]:desktop});
  const p=createAwayMicrophonePreference({...env,localStorage});assert.equal(isMobileMediaDevice(env),true);assert.equal(p.snapshot().keepMicrophone,false);assert.equal(localStorage.getItem(AWAY_MIC_KEYS.mobile),'false');assert.equal(localStorage.getItem(AWAY_MIC_KEYS.desktop),desktop??null);
  p.set(true);assert.equal(createAwayMicrophonePreference({...env,localStorage}).snapshot().keepMicrophone,true);
  p.set(false);assert.equal(createAwayMicrophonePreference({...env,localStorage}).snapshot().keepMicrophone,false);
 }
});
test('desktop default is ON; explicit choices and mobile storage remain independent',()=>{
 const localStorage=storage();const desktop=createAwayMicrophonePreference({localStorage,navigator:{platform:'MacIntel',userAgent:'Macintosh'}});assert.equal(desktop.snapshot().keepMicrophone,true);
 const mobile=createAwayMicrophonePreference({...environments[0][1],localStorage});assert.equal(mobile.snapshot().keepMicrophone,false);
 desktop.set(false);mobile.set(true);assert.equal(createAwayMicrophonePreference({localStorage}).snapshot().keepMicrophone,false);assert.equal(createAwayMicrophonePreference({...environments[0][1],localStorage}).snapshot().keepMicrophone,true);
 assert.equal(isMobileMediaDevice({navigator:{userAgent:'Windows'},innerWidth:320,matchMedia:()=>({matches:true})}),false);
});
test('only literal true enables preference and storage denial remains session-local',()=>{
 for(const value of ['1','TRUE','false',''])assert.equal(createAwayMicrophonePreference({localStorage:storage({[AWAY_MIC_KEYS.desktop]:value})}).snapshot().keepMicrophone,false);
 const p=createAwayMicrophonePreference({...environments[0][1],get localStorage(){throw Error('blocked');}});assert.equal(p.snapshot().keepMicrophone,false);p.set(true);assert.equal(p.snapshot().keepMicrophone,true);assert.equal(p.snapshot().persisted,false);
});
const projection=(conversationActive=false,liveSessionActive=false)=>readAwayConversation({awayPrivacy:{protocol:'media-away-v1',source:'proximity-membership',conversationActive,liveSessionActive,liveSessionSupported:true}});
test('hidden alone latches; hidden peer/live arrivals never clear it; only visible clears',()=>{
 const latch=createAwayLatch();assert.deepEqual(latch.update('hidden',projection()),{visible:false,away:true});assert.equal(latch.update('hidden',projection(true,true)).away,true);assert.equal(latch.update('visible',projection()).away,false);
});
test('conversation or supported live session prevent entry; last session ends while hidden enters',()=>{
 for(const starting of [projection(true),projection(false,true),projection(true,true)]){
  const latch=createAwayLatch();assert.equal(latch.update('hidden',starting).away,false);assert.equal(latch.update('hidden',projection(false,true)).away,false);assert.equal(latch.update('hidden',projection()).away,true);
 }
});
test('missing and malformed projection are unknown, never inferred from peers or meeting/stage labels',()=>{
 for(const policy of [{peers:[]},{peers:[{id:'b'}],context:{kind:'stage'}},{awayPrivacy:{protocol:'future',conversationActive:true}},{awayPrivacy:{protocol:'media-away-v1',source:'legacy-media-graph',conversationActive:false,liveSessionActive:true,liveSessionSupported:false}}])assert.equal(readAwayConversation(policy).known,false);
 const latch=createAwayLatch();assert.equal(latch.update('hidden',readAwayConversation({peers:[]})).away,true);
});
