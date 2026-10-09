/** Serial browser runs: concurrent software-WebGL suites can exhaust CI GPUs. */
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
const groups={
 guestconversations:['conversation-controls.browser.mjs','resident-chat.browser.mjs','public-guest-conversations.full.mjs','public-guest-media.browser.mjs'],
 editorflows:['editor-flow-journey.full.mjs','editor-handoff-safety.full.mjs','resident-leave-decision.browser.mjs','editor-transactions.browser.mjs','editor-image.browser.mjs','editor-save-reconciliation.browser.mjs','editor-collaboration.browser.mjs','bot-editor.browser.mjs','resident-editing-ux.browser.mjs','resident-map-tray.full.mjs'],
 publicguests:['public-guests.full.mjs','public-guest-entry.full.mjs'],
 livefeedback:['jump-input.full.mjs','native-seat-matrix.full.mjs','world-input-multipointer.browser.mjs','live-media-layout.browser.mjs','live-layout.full.mjs','quests-guidance.full.mjs','quest-area-layout.full.mjs','resident-map-tray.full.mjs','enlarged-control-text.full.mjs','live-feedback-motion.full.mjs','wall-building.full.mjs'],
 friendjourney:['complete-friend-journey.full.mjs'],
 placescreation:['places-creation-focus.browser.mjs','places-foreground.full.mjs','places-creation.full.mjs'],
 compactconversations:['compact-conversations-sheet.browser.mjs','compact-conversations-layout.full.mjs','compact-conversations.full.mjs'],
 editorpolish:['editor-polish-feedback.browser.mjs','editor-polish-experience.full.mjs','editor-flow-journey.full.mjs','editor-handoff-safety.full.mjs','resident-leave-decision.browser.mjs'],
 worldpolish:['world-presentation-occlusion.mjs'],
 shellpolish:['external-shell-journeys.mjs','external-shell-menu-input.mjs','polish-integration-side-content.mjs','polish-integration-friends.mjs'],
 signup:['conversation-controls.browser.mjs','resident-chat.browser.mjs','public-guest-conversations.full.mjs','public-guest-media.browser.mjs','public-guests.full.mjs','public-guest-entry.full.mjs','shared-entry.full.mjs','site-admission-ui.browser.mjs','open-signup-ui.browser.mjs','onboarding-continuation.full.mjs'],
 imageprotocol:['image-client-protocol.full.mjs'],
 imagesizing:['image-physical-size.browser.mjs','image-physical-size-renderer.browser.mjs','image-physical-size.full.mjs'],
 imageversions:['image-library-setup.browser.mjs','image-setup-version.full.mjs'],
 sharedareas:['editor-area-collaboration.full.mjs'],
 arrivals:['arrival-editor.browser.mjs','arrival-renderer.browser.mjs','arrival-surfaces.browser.mjs','arrival-navigation.full.mjs','arrival-reconnect.full.mjs','reconnect-authority.full.mjs'],
 groupplay:['proximity-controls-client.browser.mjs','proximity-controls.full.mjs'],
 windows:['window-control-states.browser.mjs','content-window.browser.mjs','social.browser.mjs','content-window.full.mjs'],
 terrain:['terrain-editor.browser.mjs','terrain-renderer.browser.mjs','terrain.full.mjs','terrain-keyboard.full.mjs'],
 nearby:['proximity-text-client.browser.mjs','proximity-typing-client.browser.mjs','proximity-text.full.mjs','proximity-typing.full.mjs'],
 hud:['hud-availability.browser.mjs','hud-medium-header.browser.mjs','content-history.full.mjs','input-ownership.full.mjs'],
 presentation:['creator-render.actual-game.mjs','static-delivery.browser.mjs','render-quality.browser.mjs'],
 residents:['resident-editing-ux.browser.mjs','resident-test-ui.browser.mjs','resident-turn.full.mjs'],
 framing:['panel-framing.browser.mjs','panel-framing-picking.browser.mjs','tranche-bots.browser.mjs'],
 core:['express-anchor.browser.mjs','fallback.browser.mjs','camera-walkthrough.browser.mjs','editor-direct.browser.mjs','picking-dpr.browser.mjs','avatar-live.browser.mjs','avatar-layout-final.browser.mjs','express.full.mjs'],
 modules:['avatar.browser.mjs','camera-renderer.browser.mjs','editor-transactions.browser.mjs','editor-actions.browser.mjs','bot-editor.browser.mjs','personal-areas.browser.mjs','express.browser.mjs','express.live.mjs','places.live.mjs','social.browser.mjs','social.live.mjs','media-browser.mjs','media-server-browser.mjs'],
 media:['media-away.browser.mjs','media-silent.browser.mjs','media-browser.mjs','media-server-browser.mjs','media-ice.browser.mjs','silent.full.mjs','media-freshness.full.mjs','proximity-client-native.browser.mjs'],
 images:['image-library-shell.browser.mjs','editor-image.browser.mjs','editor-toolbar.browser.mjs','image-library.full.mjs','image-lifecycle.full.mjs','editor-compact.full.mjs'],
 authoring:['editor-save-reconciliation.browser.mjs','editor-save-ack-ordering.browser.mjs','editor-save-receipt.full.mjs','editor-collaboration.browser.mjs','editor-collaboration.full.mjs','editor-collaboration-restart.full.mjs','tranche-smoke.browser.mjs','tranche-actions.browser.mjs','tranche-personal.browser.mjs','tranche-bots.browser.mjs','places.live.mjs']
};
const group=process.argv[2]||'core';if(!groups[group])throw Error('Choose '+Object.keys(groups).join(', '));
await mkdir('evidence',{recursive:true});const results=[];
for(const file of groups[group]){
 console.log('\n=== '+file+' ===');const start=Date.now();
 const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['tests/'+file],{stdio:'inherit',env:{...process.env,...(file==='content-history.full.mjs'?{CONTENT_HISTORY_POINTER_CLOSE:'1'}:{})}});child.once('error',reject);child.once('exit',code=>resolve(code??1));});
 results.push({file,exitCode:code,durationMs:Date.now()-start});
 await writeFile(`evidence/browser-${group}-summary.json`,JSON.stringify({scope:group,results},null,2));
 if(code){process.exitCode=code;break;}
}
