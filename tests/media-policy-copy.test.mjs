import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {activeMediaArea,mediaAreaMessage,mediaAreaLabel,SILENT_MEDIA_MESSAGE,SILENT_MEDIA_EXIT_MESSAGE} from '../src/media-policy-copy.js';
test('Silent banner wins every overlap regardless of scene order and cannot be replaced by custom message',()=>{
 const quiet={name:'Garden',action:'silent',message:'Legacy: proximity calls paused'};
 for(const action of ['meeting','stage','audience','welcome'])for(const areas of [[{name:'Other',action},quiet],[quiet,{name:'Other',action}]])assert.equal(activeMediaArea(areas),quiet);
 assert.equal(mediaAreaMessage(quiet),SILENT_MEDIA_MESSAGE);assert.match(mediaAreaLabel(quiet),/Garden.*No calls/);assert.match(SILENT_MEDIA_MESSAGE,/No calls here/);assert.match(SILENT_MEDIA_MESSAGE,/microphone, camera and screen sharing are off/);assert.match(SILENT_MEDIA_MESSAGE,/incoming calls are blocked/);assert.match(SILENT_MEDIA_EXIT_MESSAGE,/listening can resume if you stayed joined/);
});
test('Non-Silent area messages remain editable',()=>{const area={name:'Meeting',action:'meeting',message:'Custom welcome'};assert.equal(mediaAreaMessage(area),'Custom welcome');assert.equal(mediaAreaLabel(area),'Meeting');assert.equal(activeMediaArea([]),undefined);});
test('Banner, seed, editor and server wire the mandatory shared Silent copy',async()=>{
 const source=async name=>readFile(new URL('../'+name,import.meta.url),'utf8');
 assert.match(await source('src/main.js'),/const area=activeMediaArea\(active\)/);assert.match(await source('src/main.js'),/textContent=mediaAreaMessage\(area\)/);assert.match(await source('src/main.js'),/textContent=mediaAreaLabel\(area\)/);
 assert.match(await source('src/worlds.js'),/message:SILENT_MEDIA_MESSAGE/);assert.match(await source('src/editor.js'),/\['silent','Silent \/ no calls'\]/);assert.match(await source('server/media.mjs'),/reason:SILENT_MEDIA_MESSAGE/);
});
