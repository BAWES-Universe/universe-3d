import {screenGridStep} from './editor-geometry.js';
import {moveBotHandle} from './bot-preview.js';
import {navigationPolicy} from '../server/bot-navigation.mjs';
const sameIdentity=(a,b)=>a?.roomId===b?.roomId&&a?.botId===b?.botId;
export function createBotMapInput({getEditor,getState,getPreview,showPreview,getCameraAngle=()=>Math.PI/4,toast}){
 let gesture=null,selected='spawn';
 const identity=()=>getEditor()?.getIdentity();
 function cancelGesture(){const had=!!gesture;gesture=null;const bot=getEditor()?.getDraft();showPreview(bot||null);return had;}
 function admissible(bot){const valid=navigationPolicy(getState().scene,bot);return valid(bot.spawn)&&bot.waypoints.every(valid);}
 function patchFor(bot,handle){return handle==='spawn'?{spawn:bot.spawn}:handle==='radius'?{radius:bot.radius}:{waypoints:bot.waypoints};}
 function commit(bot,handle,owner){if(!sameIdentity(identity(),owner))return false;if(!admissible(bot)){toast('Keep the resident and route on clear ground inside its radius');return false;}return getEditor().updateMap({...owner,...patchFor(bot,handle)});}
 return {
  pointerDown(hit,event={}){const data=getPreview();if(!data?.bot||hit?.type!=='bot-handle'||!hit.point)return false;selected=hit.id;gesture={handle:hit.id,owner:{...identity()},base:structuredClone(data.bot),point:hit.point,client:{x:event.clientX||0,y:event.clientY||0},preview:null};return true;},
  pointerMove(hit,event={}){if(!gesture||!hit?.point)return false;if(!sameIdentity(identity(),gesture.owner)){cancelGesture();return false;}if(Math.hypot((event.clientX||0)-gesture.client.x,(event.clientY||0)-gesture.client.y)<5)return true;const next=moveBotHandle(gesture.base,gesture.handle,hit.point);gesture.preview=next;showPreview(next);return true;},
  pointerUp(hit,event={}){if(!gesture)return false;this.pointerMove(hit,event);const done=gesture;gesture=null;if(done.preview)commit(done.preview,done.handle,done.owner);showPreview(getEditor()?.getDraft()||null);return true;},
  cancelGesture,
  nudge(key){const bot=getEditor()?.getDraft();if(!bot)return;const p=selected==='radius'?{x:bot.spawn.x+bot.radius,z:bot.spawn.z}:selected.startsWith('waypoint:')?bot.waypoints[Number(selected.slice(9))]:bot.spawn;if(!p)return;const delta=screenGridStep(key.toLowerCase(),getCameraAngle(),.5),point={x:p.x+delta.x,z:p.z+delta.z};commit(moveBotHandle(bot,selected,point),selected,identity());},
  isDragging:()=>!!gesture,
 };
}
