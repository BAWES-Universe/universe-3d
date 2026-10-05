import {screenGridStep} from './editor-geometry.js';
import {moveBotHandle} from './bot-preview.js';
import {navigationPolicy} from '../server/bot-navigation.mjs';
const sameIdentity=(a,b)=>a?.roomId===b?.roomId&&a?.botId===b?.botId;
export function createBotMapInput({getEditor,getState,getPreview,showPreview,getCameraAngle=()=>Math.PI/4,toast}){
 let gesture=null,selected='spawn';
 const identity=()=>getEditor()?.getIdentity();
 function cancelGesture(){const had=!!gesture;gesture=null;const bot=getEditor()?.getDraft();showPreview(bot||null);return had;}
 function admissible(bot){const valid=navigationPolicy(getState().scene,bot);return bot.radius<=100&&valid(bot.spawn)&&bot.waypoints.every(valid);}
 function patchFor(bot,handle){return handle==='spawn'?{spawn:bot.spawn,radius:bot.radius}:handle==='radius'?{radius:bot.radius}:{waypoints:bot.waypoints,radius:bot.radius};}
 function move(bot,handle,point){const next=moveBotHandle(bot,handle,point);if(handle!=='radius'&&next.waypoints.length)next.radius=Math.max(next.radius,Math.ceil(Math.max(...next.waypoints.map(p=>Math.hypot(p.x-next.spawn.x,p.z-next.spawn.z)))*10)/10);return next;}
 function commit(bot,handle,owner){if(!sameIdentity(identity(),owner))return false;if(!admissible(bot)){toast('Choose clear ground inside the room, away from blocked or restricted areas');return false;}return getEditor().updateMap({...owner,...patchFor(bot,handle)});}
 return {
  pointerDown(hit,event={}){const data=getPreview(),mode=getEditor()?.getMapMode?.();if(!data?.bot||!hit?.point)return false;if(hit.type!=='bot-handle'&&!mode)return false;const placement=hit.type!=='bot-handle';selected=placement?mode:hit.id;gesture={handle:selected,placement,owner:{...identity()},base:structuredClone(data.bot),point:hit.point,client:{x:event.clientX||0,y:event.clientY||0},preview:null};return true;},
  pointerMove(hit,event={}){if(!gesture||!hit?.point)return false;if(!sameIdentity(identity(),gesture.owner)){cancelGesture();return false;}if(Math.hypot((event.clientX||0)-gesture.client.x,(event.clientY||0)-gesture.client.y)<5)return true;const next=gesture.placement?getEditor()?.previewMapPoint?.(hit.point):move(gesture.base,gesture.handle,hit.point);gesture.preview=next;if(next)showPreview(next);return true;},
  pointerUp(hit,event={}){if(!gesture)return false;this.pointerMove(hit,event);const done=gesture;gesture=null;if(sameIdentity(identity(),done.owner)){if(done.placement&&hit?.point)getEditor()?.placeMapPoint?.(hit.point);else if(done.preview)commit(done.preview,done.handle,done.owner);else if(done.handle!=='radius')getEditor()?.beginMapMode?.(done.handle);}showPreview(getEditor()?.getDraft()||null);return true;},
  cancelGesture,
  nudge(key){const bot=getEditor()?.getDraft();if(!bot)return;const mode=getEditor()?.getMapMode?.();if(mode==='add')return;if(mode)selected=mode;const p=selected==='radius'?{x:bot.spawn.x+bot.radius,z:bot.spawn.z}:selected.startsWith('waypoint:')?bot.waypoints[Number(selected.slice(9))]:bot.spawn;if(!p)return;const delta=screenGridStep(key.toLowerCase(),getCameraAngle(),.5),point={x:p.x+delta.x,z:p.z+delta.z};commit(move(bot,selected,point),selected,identity());},
  isDragging:()=>!!gesture,
 };
}
