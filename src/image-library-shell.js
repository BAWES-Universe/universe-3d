import {createImageLibraryClient} from './image-library-client.js';
import {mountImageLibrary} from './image-library-panel.js';
import {bindImageDefinitions,imageDefinitions,imageReferenceKey,mergeImageDefinitions} from './image-asset-context.js';
import {canBuildInRoom} from './personal-editor-policy.js';
import {roomAllows} from './permissions.js';
import {validateResolvedImageAsset} from './image-asset-schema.js';

// This port carries no actor or role claims. The HTTP handler resolves the live
// session from the existing same-origin cookie and checks it again at commit.
export function createImageAssetTransport({request=globalThis.fetch?.bind(globalThis)}={}){
 const base=roomId=>'/api/rooms/'+encodeURIComponent(roomId)+'/assets';
 async function fetchAsset(url,{signal,body,image=false,method=body?'POST':'GET'}={}){
  const response=await request(url,{method,credentials:'same-origin',mode:'same-origin',cache:'no-store',signal,headers:body?{'Content-Type':'application/json','Accept':'application/json'}:{Accept:image?'image/png':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok){let value;try{value=await response.json();}catch{}const error=new Error(value?.error?.message||value?.message||'The image request could not be completed');error.status=response.status;error.code=value?.error?.code;throw error;}
  return image?response.blob():response.json();
 }
 return Object.freeze({
  list:({roomId,query='',status='active',signal})=>fetchAsset(base(roomId)+'?query='+encodeURIComponent(query)+(status==='active'?'':'&status='+encodeURIComponent(status)),{signal}),
  update:({roomId,assetId,expectedRevision,metadata,status,signal})=>fetchAsset(base(roomId)+'/'+encodeURIComponent(assetId),{method:'PATCH',signal,body:{expectedRevision,...(metadata?{metadata}:{status})}}),
  create:({roomId,draft,bytes,mediaType,operationId,signal})=>{
   if(!(bytes instanceof Uint8Array))throw new TypeError('PNG bytes are required');
   let binary='';for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
   return fetchAsset(base(roomId),{signal,body:{draft,pngBase64:btoa(binary),mediaType,operationId}});
  },
  reconcileCreate:({roomId,operationId,signal})=>fetchAsset(base(roomId)+'/operations/'+encodeURIComponent(operationId),{signal}),
  readImage:({roomId,assetId,versionId,signal})=>fetchAsset(base(roomId)+'/'+encodeURIComponent(assetId)+'/versions/'+encodeURIComponent(versionId)+'/image',{signal,image:true})
 });
}

export function mountImageLibraryShell({root,statusRoot,getState,getRenderer,onChoose,onOpenChange=()=>{},onDefinitions=()=>{},onAuthorityLost=()=>{},icon,transport=createImageAssetTransport(),mountPanel=mountImageLibrary}){
 let roomEpoch=0,authorityEpoch=0,suspended=true,disposed=false,lastContext='',reportedOpen=false,renderer=null;
 let owner=null;
 const client=createImageLibraryClient({transport});
 const context=()=>{const state=getState(),canRead=!!(state.user?.id&&state.room?.id&&state.ready&&!suspended&&state.room.capabilities?.canRead!==false);return{accountId:state.user?.id||null,roomId:state.room?.id||null,roomEpoch,capabilities:{canRead,canPlace:canRead&&!!getRenderer()&&canBuildInRoom(state.room),canManage:canRead&&roomAllows(state.room,'canEditScene')}};};
 const stamp=()=>JSON.stringify([context().accountId,context().roomId,roomEpoch,authorityEpoch]);
 const authorityStamp=()=>{const ctx=context();return JSON.stringify([ctx.accountId,ctx.roomId,ctx.capabilities]);};
 const ownerStamp=()=>JSON.stringify([getState().user?.id||null,getState().room?.id||null]);
 function bindCurrent(){const state=getState();if(!state.room?.id||!state.scene)return;bindImageDefinitions(state.scene,state.room.imageDefinitions||{},state.room.id);}
 function cache(entries,scope,roomId){
  if(disposed||scope!==stamp()||!context().capabilities.canRead||roomId!==getState().room?.id)return;
  const state=getState(),definitions={...(state.room.imageDefinitions||{})};
  for(const entry of entries){
   for(const [key,known]of Object.entries(definitions))if(known.definition.assetId===entry.definition.assetId&&((entry.revision??1)>=(known.revision??1)))definitions[key]=validateResolvedImageAsset({...known,status:entry.status,...(entry.metadata?{metadata:entry.metadata}:{}),...(entry.revision?{revision:entry.revision}:{})});
   const key=imageReferenceKey({assetId:entry.definition.assetId,versionId:entry.version.versionId});
   if(!definitions[key]||(entry.revision??1)>=(definitions[key].revision??1))definitions[key]=entry;
  }
  // Binding validates every envelope and room before mutating the shared map.
  bindImageDefinitions(state.scene,definitions,roomId);state.room.imageDefinitions=definitions;onDefinitions();
 }
 async function invoke(method,args){const scope=stamp();try{const result=await client[method](args);const entries=method==='list'?result.entries:['create','update'].includes(method)?[result]:method==='reconcileCreate'&&result.status==='committed'?[result.entry]:[];if(entries.length)cache(entries,scope,args.roomId);return result;}catch(error){if(scope===stamp()&&(error.status===401||method==='list'&&error.status===404)){suspend();onAuthorityLost(error);}throw error;}}
 const service=Object.freeze(Object.fromEntries(['list','create','update','reconcileCreate','readImage'].map(method=>[method,args=>invoke(method,args)])));
 const panel=mountPanel({root,getContext:context,service,icon,onChoose:ref=>{if(!context().capabilities.canPlace)return;if(onChoose(ref)!==false)setOpen(false,{focusWorld:true});}});
 function reportOpen(){const next=!root.hidden;if(reportedOpen===next)return;reportedOpen=next;onOpenChange(next);}
 const visibility=new MutationObserver(reportOpen);visibility.observe(root,{attributes:true,attributeFilter:['hidden']});
 function setOpen(value,{trigger,focusWorld=false,record=true}={}){
  if(value&&!context().capabilities.canRead)return false;
  if(!!value===isOpen()){if(!record)reportedOpen=isOpen();if(focusWorld)document.getElementById('game')?.focus({preventScroll:true});return true;}
  panel.setOpen(value,trigger);if(record)reportOpen();else reportedOpen=!root.hidden;
  if(focusWorld)document.getElementById('game')?.focus({preventScroll:true});return true;
 }
 function renderStatus(values){
  if(!statusRoot)return;statusRoot.replaceChildren();
  if(!context().capabilities.canRead){statusRoot.hidden=true;return;}
  const statuses=Array.isArray(values)?values:Object.values(values||{}),pending=statuses.filter(value=>['loading','error'].includes(value.status));
  statusRoot.hidden=!pending.length;
  for(const value of pending){const row=document.createElement('div'),text=document.createElement('span');text.textContent=(value.name||'Custom image')+(value.status==='loading'?' is loading…':' could not load');row.append(text);if(value.status==='error'){const retry=document.createElement('button');retry.type='button';retry.textContent='Retry';retry.setAttribute('aria-label','Retry '+(value.name||'Custom image'));retry.onclick=()=>getRenderer()?.retryImage(value.id);row.append(retry);}statusRoot.append(row);}
 }
 function syncRenderer(){const next=getRenderer();if(next!==renderer){renderer?.setImageStateListener?.(null);renderer=next;renderer?.setImageStateListener?.(renderStatus);}const ctx=context();renderer?.setImageContext?.({roomId:ctx.roomId,roomEpoch,authorityEpoch,canRead:ctx.capabilities.canRead});renderStatus(renderer?.getImageStates?.()||[]);}
 function syncAuthority({force=false}={}){
  const next=authorityStamp();if(force||next!==lastContext){roomEpoch++;authorityEpoch++;lastContext=next;syncRenderer();panel.attachRoom();}else syncRenderer();
  if(!context().capabilities.canRead&&isOpen())setOpen(false);
 }
 function suspend(){suspended=true;roomEpoch++;authorityEpoch++;syncRenderer();panel.attachRoom();if(isOpen())setOpen(false,{record:false});lastContext=authorityStamp();}
 function resume(){suspended=false;roomEpoch++;owner=ownerStamp();syncAuthority({force:true});bindCurrent();onDefinitions();}
 function prepareRoom(room,{preserve=true}={}){
  if(!room?.id||!room.scene)return room;
  const state=getState(),same=preserve&&owner===ownerStamp()&&state.room?.id===room.id;
  const retained=same?mergeImageDefinitions(state.room.imageDefinitions,imageDefinitions(state.scene)):{};
  const definitions=mergeImageDefinitions(retained,room.imageDefinitions);
  bindImageDefinitions(room.scene,definitions,room.id);room.imageDefinitions=definitions;
  return room;
 }
 function acceptRoom(){suspended=false;owner=ownerStamp();syncAuthority({force:true});bindCurrent();}
 function receiveRoom(room){prepareRoom(room);if(room?.id===getState().room?.id){getState().room.imageDefinitions=room.imageDefinitions||{};bindCurrent();}return room;}
 function isOpen(){return !root.hidden;}
 function hasFocus(target=document.activeElement){return !!target&&root.contains(target);}
 function refresh(event){if(!context().capabilities.canRead)return;
  if(event?.assetId&&['active','archived'].includes(event.status)){
   const entries=Object.values(getState().room.imageDefinitions||{}).filter(entry=>entry.definition.assetId===event.assetId).map(entry=>validateResolvedImageAsset({...entry,status:event.status,metadata:event.metadata||entry.metadata,revision:event.revision||entry.revision}));
   if(entries.length)cache(entries,stamp(),context().roomId);
  }
  if(isOpen())return panel.refresh();return service.list({roomId:context().roomId,query:''}).catch(()=>{});}
 function dispose(){disposed=true;visibility.disconnect();renderer?.setImageStateListener?.(null);panel.dispose();statusRoot?.replaceChildren();}
 return Object.freeze({isOpen,hasFocus,setOpen,refresh,suspend,resume,prepareRoom,receiveRoom,acceptRoom,syncAuthority,syncRenderer,getContext:context,dispose});
}
