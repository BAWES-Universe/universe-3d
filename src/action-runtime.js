import {itemActions,actionName,safeActionUrl} from './action-schema.js';
import {contains} from './worlds.js';
import {activeMediaArea} from './media-policy-copy.js';
import {createAreaActionController} from './actions.js';
import {createAudioActions} from './audio-actions.js';
import {mountEmbeddedPanels} from './embedded-panels.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const legacyAreaActions=area=>[...(area.action==='link'&&area.url?[{id:'legacy-area-link',type:'link',url:area.url,label:area.name,mode:'tab',trigger:'enter'}]:[]),...(area.action==='teleport'&&area.target?[{id:'legacy-area-target',type:'teleport',target:area.target,...(area.entry===undefined?{}:{entry:area.entry}),label:area.name,trigger:'enter'}]:[]),...(area.actions||[])];
export function mountActionRuntime({root,controlsRoot,api,getState,beforeResolve=async()=>{},onDialog,onCloseDialog=()=>{},onNavigate,onOpenChange=()=>{},getGameWidth,onWindowChange=()=>{},toast=()=>{}}){
 let scope='',userId='',epoch=0,activeMenu=null,lastFrameRef=null,lastFrameKey=null,restoreEpoch=0;const inflight=new Map(),resources=new Map(),controls=new Map(),landingExits=new Set();
 const areaList=el('div','area-action-list'),audioRoot=el('div','world-audio-controls');controlsRoot.replaceChildren(areaList,audioRoot);
 // Automatic area messages are readable, dismissible notices, not movement-locking dialogs.
 const notices=el('section','area-entry-messages');notices.setAttribute('aria-label','Area messages');notices.hidden=true;(root.parentElement||controlsRoot.parentElement||controlsRoot).append(notices);
 const noticeEntries=new Map(),dismissedNotices=new Map();
 const banner=document.getElementById?.('area-banner');let bannerKey='';
 if(banner){banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');const dismiss=el('button','area-banner-dismiss','×');dismiss.type='button';dismiss.setAttribute('aria-label','Dismiss area message');dismiss.onclick=()=>{banner.dataset.dismissed='true';};banner.append(dismiss);}
 function showNotice(id,message,ref){
  if(dismissedNotices.has(id))return;
  let row=noticeEntries.get(id);if(!row){const card=el('article','area-entry-message'),title=el('strong'),text=el('p'),dismiss=el('button','','×');dismiss.type='button';dismiss.setAttribute('aria-label','Dismiss '+message.title);card.setAttribute('role','status');card.setAttribute('aria-live','polite');dismiss.onclick=()=>{dismissedNotices.set(id,{ref:{...ref},fingerprint:JSON.stringify(find(ref)?.action)});card.hidden=true;notices.hidden=![...noticeEntries.values()].some(v=>!v.card.hidden);};card.append(title,text,dismiss);notices.append(card);row={card,title,text};noticeEntries.set(id,row);}
  row.title.textContent=message.title;row.text.textContent=message.text;row.card.hidden=false;notices.hidden=false;
 }
 function clearNotice(id){const row=noticeEntries.get(id);if(row){row.card.remove();noticeEntries.delete(id);}notices.hidden=![...noticeEntries.values()].some(v=>!v.card.hidden);}
 const frames=mountEmbeddedPanels({root,onOpenChange,getGameWidth,onWindowChange,toast});
 let storedVolume=1;try{storedVolume=Number(localStorage.getItem('universe-world-volume')??1);}catch{}
 const audio=createAudioActions({initialVolume:storedVolume,saveVolume:value=>{try{localStorage.setItem('universe-world-volume',String(value));}catch{}},onChange:renderAudio,onError:()=>{}});
 const audioRows=new Map();let volumeRow=null,volumeRange=null,muteButton=null;
 function renderAudio(snapshot){
  audioRoot.hidden=!snapshot.entries.length;
  if(!volumeRow){volumeRow=el('div','world-audio-volume');const title=el('label','','World sound');volumeRange=el('input');volumeRange.type='range';volumeRange.min='0';volumeRange.max='1';volumeRange.step='.05';volumeRange.setAttribute('aria-label','World sound volume');volumeRange.oninput=()=>audio.setVolume(Number(volumeRange.value));muteButton=el('button');muteButton.type='button';muteButton.onclick=()=>audio.setMuted(!audio.snapshot().muted);volumeRow.append(title,volumeRange,muteButton);audioRoot.append(volumeRow);}
  if(document.activeElement!==volumeRange)volumeRange.value=String(snapshot.userVolume);muteButton.textContent=snapshot.muted?'Unmute':'Mute';muteButton.setAttribute('aria-pressed',String(snapshot.muted));
  const active=new Set(snapshot.entries.map(item=>item.key));for(const[key,row]of audioRows)if(!active.has(key)){row.holder.remove();audioRows.delete(key);}
  for(const item of snapshot.entries){let row=audioRows.get(item.key);if(!row){const holder=el('div','world-audio-row'),name=el('strong'),play=el('button'),stop=el('button','','Stop'),error=el('span','world-audio-error');play.type=stop.type='button';error.setAttribute('role','status');row={holder,name,play,stop,error,item};play.onclick=()=>row.item.status==='playing'?audio.pause(item.key):resources.get(item.key)&&activate(resources.get(item.key).ref,{deliberate:true});stop.onclick=()=>audio.stop(item.key);holder.append(name,play,stop,error);audioRows.set(item.key,row);audioRoot.append(holder);}row.item=item;row.name.textContent=item.label;row.play.textContent=item.status==='playing'?'Pause':item.status==='error'?'Retry':'Play';row.play.setAttribute('aria-label',(item.status==='playing'?'Pause ':'Play ')+item.label);row.stop.setAttribute('aria-label','Stop '+item.label);row.play.disabled=item.status==='loading';row.error.textContent=item.error;row.error.hidden=!item.error;}
 }
 function key(ref){return `${ref.roomId}:${ref.entityType}:${ref.entityId}:${ref.actionId}`;}
 function find(ref){const state=getState();if(state.room?.id!==ref.roomId)return null;const entity=(ref.entityType==='item'?state.scene?.objects:state.scene?.areas)?.find(e=>e.id===ref.entityId);const action=entity&&(ref.entityType==='item'?itemActions(entity):legacyAreaActions(entity)).find(a=>a.id===ref.actionId);return entity&&action?{entity,action}:null;}
 function reference(entityType,entity,action){return{roomId:getState().room.id,entityType,entityId:entity.id,actionId:action.id};}
 function openItem(id){
  const state=getState(),item=state.scene?.objects.find(o=>o.id===id);if(!state.ready||!item)return false;activeMenu={roomId:state.room.id,entityId:id};
  onDialog({owner:'room-item:'+id,eyebrow:'ROOM ITEM',title:item.name||item.type,text:item.text||'Choose what you’d like to do.',actions:itemActions(item).map(action=>({label:actionName(action),description:action.description,run:()=>activate(reference('item',item,action),{deliberate:true})}))});return true;
 }
 async function activate(ref,{deliberate=false,forceTab=false,restoring=false,focus=true,isCurrent=()=>true}={}){
  const current=find(ref);if(!isCurrent()||!current||!getState().ready){toast('This action is no longer available');return false;}
  const id=key(ref);if(inflight.has(id))return false;const requested=JSON.stringify(current.action),started=epoch,actorId=getState().user?.id,token={popup:null,restoring};inflight.set(id,token);
  // Reserve only on a direct gesture; URL navigation happens after fresh authority.
  if(deliberate&&current.action.type==='link'&&(forceTab||current.action.mode!=='embed')&&safeActionUrl(current.action.url,location.origin)?.kind==='external'){
   try{token.popup=window.open('about:blank','_blank');if(token.popup)token.popup.opener=null;}catch{}
  }
  controls.get(id)?.setAttribute('aria-busy','true');
  try{
   await beforeResolve({ref,deliberate});if(!isCurrent()||!getState().ready||getState().user?.id!==actorId||epoch!==started||inflight.get(id)!==token||!find(ref))return false;
   const revision=getState().room.revision,response=await api(`/api/rooms/${encodeURIComponent(ref.roomId)}/actions/resolve`,{method:'POST',body:{entityType:ref.entityType,entityId:ref.entityId,actionId:ref.actionId,revision}});
   if(!isCurrent()||!getState().ready||getState().user?.id!==actorId||epoch!==started||inflight.get(id)!==token||getState().room?.id!==ref.roomId||getState().room.revision!==response.revision||JSON.stringify(find(ref)?.action)!==requested)return false;
   const action=response.action;if(['type','url','target','entry','message','volume','loop','width','closable'].some(field=>action[field]!==current.action[field]))throw Error('This action changed. Open the item again.');const safe=action.url?safeActionUrl(action.url,location.origin):null;
   if(action.url&&!safe)throw Error('This item needs a safe HTTP(S), asset or protected document address');
   resources.set(id,{ref,fingerprint:JSON.stringify(current.action)});activeMenu=null;
   if(action.type==='message'){const message={owner:'room-action:'+id,eyebrow:response.entity.name,title:action.name||action.label||'A message for you',text:action.message||''};if(ref.entityType==='area'&&!deliberate)showNotice(id,message,ref);else onDialog(message);}
   if(action.type==='teleport'){await onNavigate(action.target,{...(action.entry===undefined?{}:{entry:action.entry}),sourceAction:{...ref,revision:response.revision}});return true;}
   if(action.type==='audio'){
    if(safe.kind==='document')throw Error('Protected documents download; they cannot be used as room audio');
    await audio.play({key:id,url:safe.url,label:action.label||action.name||response.entity.name,volume:action.volume??1,loop:action.loop??false});
   }
   if(action.type==='link'){
    if(action.document||safe.kind==='document'){
     const link=el('a');link.href=safe.url;link.download=action.document?.name||'';link.rel='noopener';link.click();
    }else if(action.mode==='embed'&&!forceTab){
     lastFrameRef={...ref};if(!restoring&&!frames.isOpen())lastFrameKey=crypto.randomUUID();frames.open({key:id,url:safe.url,title:action.label||action.name||response.entity.name,width:action.width,closable:action.closable,onExternal:()=>activate(ref,{deliberate:true,forceTab:true})},{focus});
    }else if(token.popup){token.popup.location.replace(new URL(safe.url,location.origin).href);token.popup=null;}
    else if(deliberate){const opened=window.open(new URL(safe.url,location.origin).href,'_blank','noopener,noreferrer');if(!opened)toast('If a new tab did not open, allow popups and activate this link again');}
    else{toast('This link needs your click to open a browser tab');}
   }
   return true;
  }catch(error){toast(error.message||'This action could not run. Try opening the item again.');return false;}
  finally{try{token.popup?.close();}catch{}if(inflight.get(id)===token)inflight.delete(id);controls.get(id)?.removeAttribute('aria-busy');}
 }
 const areaController=createAreaActionController({enter:({area,action})=>{
  const ref=reference('area',area,action),id=key(ref),button=el('button','small-btn',action.label||action.name||actionName(action));button.type='button';button.onclick=()=>activate(ref,{deliberate:true});const holder=el('div','area-action-control');holder.append(button);areaList.append(holder);controls.set(id,button);
  const trigger=action.trigger??(action.type==='audio'||action.type==='teleport'?'enter':'interact');
  if(trigger==='enter'&&!(action.type==='teleport'&&landingExits.has(area.id)))void activate(ref);
 },leave:({area,action})=>{const id=key({roomId:scope,entityType:'area',entityId:area.id,actionId:action.id});controls.get(id)?.parentElement?.remove();controls.delete(id);release(id);}});
 function release(id){clearNotice(id);if(lastFrameRef&&key(lastFrameRef)===id){lastFrameRef=null;restoreEpoch++;}const pending=inflight.get(id);try{pending?.popup?.close();}catch{}inflight.delete(id);resources.delete(id);audio.stop(id);frames.close(id);if(!frames.isOpen()&&!lastFrameRef)lastFrameKey=null;}
 function clear(){dismissedNotices.clear();for(const id of [...noticeEntries.keys()])clearNotice(id);bannerKey='';if(banner)delete banner.dataset.dismissed;epoch++;restoreEpoch++;landingExits.clear();lastFrameRef=null;lastFrameKey=null;if(activeMenu)onCloseDialog('room-item:'+activeMenu.entityId);for(const id of resources.keys())onCloseDialog('room-action:'+id);areaController.clear();for(const pending of inflight.values())try{pending.popup?.close();}catch{}inflight.clear();resources.clear();controls.clear();areaList.replaceChildren();audio.clear();frames.clear();activeMenu=null;}
 function arrive(roomId,scene,position){clear();scope=roomId;userId=getState().user?.id||'';for(const area of scene?.areas||[])if(contains(area,position.x,position.z))landingExits.add(area.id);}
 function update({suppressed=false}={}){
  const state=getState(),room=state.room?.id||'',person=state.user?.id||'';if(scope!==room||userId!==person){clear();scope=room;userId=person;lastFrameRef=null;}
  if(!state.ready||!room){clear();return;}
  for(const[id,value]of dismissedNotices){const current=find(value.ref);if(!current||JSON.stringify(current.action)!==value.fingerprint||!contains(current.entity,state.position.x,state.position.z))dismissedNotices.delete(id);}
  if(banner){const area=activeMediaArea((state.scene?.areas||[]).filter(area=>contains(area,state.position.x,state.position.z)));const next=area?JSON.stringify([room,person,area.id,area.message,area.action]):'';if(next!==bannerKey){bannerKey=next;delete banner.dataset.dismissed;}}
  if(activeMenu){const item=state.scene.objects.find(o=>o.id===activeMenu.entityId);if(!item){onCloseDialog('room-item:'+activeMenu.entityId);activeMenu=null;}}
  for(const id of landingExits){const area=state.scene.areas?.find(area=>area.id===id);if(!area||!contains(area,state.position.x,state.position.z))landingExits.delete(id);}
  const scene={...state.scene,areas:(state.scene.areas||[]).map(area=>({...area,actions:legacyAreaActions(area)}))};areaController.update(room,scene,state.position,{suppressed});
  for(const[id,value]of resources){const actual=find(value.ref);if(!actual||JSON.stringify(actual.action)!==value.fingerprint||(value.ref.entityType==='area'&&!contains(actual.entity,state.position.x,state.position.z))){onCloseDialog('room-action:'+id);release(id);}}
 }
 function cancelRestore(){restoreEpoch++;for(const[id,token]of inflight)if(token.restoring)inflight.delete(id);}
 function close(){cancelRestore();frames.clear();}
 async function restore(contentKey,{focus=true,isCurrent=()=>true}={}){const state=getState();if(!lastFrameRef||contentKey!==lastFrameKey||scope!==state.room?.id||userId!==state.user?.id||!state.ready)return false;cancelRestore();const current=restoreEpoch;const ok=await activate(lastFrameRef,{restoring:true,focus,isCurrent:()=>current===restoreEpoch&&contentKey===lastFrameKey&&isCurrent()});return current===restoreEpoch&&isCurrent()?ok:null;}
 return {openItem,activate,update,clear,arrive,isOpen:()=>frames.isOpen(),hasFocus:()=>frames.hasFocus(),historyKey:()=>lastFrameKey,windowState:()=>frames.windowState(),setWindowForeground:value=>frames.setForeground(value),setWindowMaximized:value=>frames.setMaximized(value),handleWindowEscape:event=>frames.handleEscape(event),refreshWindowLayout:()=>frames.refreshLayout(),close,restore,audio,hasActions:item=>itemActions(item).length>0,destroy(){clear();frames.destroy();notices.remove();banner?.querySelector('.area-banner-dismiss')?.remove();controlsRoot.replaceChildren();}};
}
