/** Serial browser runs: concurrent software-WebGL suites can exhaust CI GPUs. */
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
const groups={
 groupplay:['proximity-controls-client.browser.mjs','proximity-controls.full.mjs'],
 windows:['window-control-states.browser.mjs','content-window.browser.mjs','social.browser.mjs','content-window.full.mjs'],
 terrain:['terrain-editor.browser.mjs','terrain-renderer.browser.mjs','terrain.full.mjs','terrain-keyboard.full.mjs'],
 nearby:['proximity-text-client.browser.mjs','proximity-typing-client.browser.mjs','proximity-text.full.mjs','proximity-typing.full.mjs'],
 hud:['hud-availability.browser.mjs','hud-medium-header.browser.mjs','content-history.full.mjs'],
 presentation:['creator-render.actual-game.mjs'],
 residents:['resident-test-ui.browser.mjs','resident-turn.full.mjs'],
 framing:['panel-framing.browser.mjs','panel-framing-picking.browser.mjs','tranche-bots.browser.mjs'],
 core:['fallback.browser.mjs','camera-walkthrough.browser.mjs','editor-direct.browser.mjs','picking-dpr.browser.mjs','avatar-live.browser.mjs','avatar-layout-final.browser.mjs','express.full.mjs'],
 modules:['avatar.browser.mjs','camera-renderer.browser.mjs','editor-transactions.browser.mjs','editor-actions.browser.mjs','bot-editor.browser.mjs','personal-areas.browser.mjs','express.browser.mjs','express.live.mjs','places.live.mjs','social.browser.mjs','social.live.mjs','media-browser.mjs','media-server-browser.mjs'],
 media:['media-away.browser.mjs','media-silent.browser.mjs','media-browser.mjs','media-server-browser.mjs','media-ice.browser.mjs','silent.full.mjs','media-freshness.full.mjs','proximity-client-native.browser.mjs'],
 images:['image-library-shell.browser.mjs','editor-image.browser.mjs','editor-toolbar.browser.mjs','image-library.full.mjs','image-lifecycle.full.mjs'],
 authoring:['tranche-smoke.browser.mjs','tranche-actions.browser.mjs','tranche-personal.browser.mjs','tranche-bots.browser.mjs']
};
const group=process.argv[2]||'core';if(!groups[group])throw Error('Choose core, modules, authoring, images, media, framing, residents, presentation, hud, nearby, terrain, windows or groupplay');
await mkdir('evidence',{recursive:true});const results=[];
for(const file of groups[group]){
 console.log('\n=== '+file+' ===');const start=Date.now();
 const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['tests/'+file],{stdio:'inherit',env:{...process.env,...(file==='content-history.full.mjs'?{CONTENT_HISTORY_POINTER_CLOSE:'1'}:{})}});child.once('error',reject);child.once('exit',code=>resolve(code??1));});
 results.push({file,exitCode:code,durationMs:Date.now()-start});
 await writeFile(`evidence/browser-${group}-summary.json`,JSON.stringify({scope:group,results},null,2));
 if(code){process.exitCode=code;break;}
}
