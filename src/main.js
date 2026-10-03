import {createArrivalNavigation,initialArrivalMode} from './arrival-navigation.js';
import {readTravelLocation,writeTravelLocation,destinationKey} from './travel-location.js';
import {createArrivalShare} from './arrival-share.js';
import './arrival-share.css';
import {activeMediaArea,mediaAreaMessage,mediaAreaLabel} from './media-policy-copy.js';
import {icon} from './universe-icons.js';
import {mountImageLibraryShell} from './image-library-shell.js';
import './image-library-panel.css';
import './image-library-shell.css';
import {seedWorlds,clone,findPath,movePlayer,canStand,nearestWalkable,contains,pathDirection} from './worlds.js';
import {AVATAR_PRESETS,normalizeAppearance,appearanceForUser} from './avatar-spec.js';
import {mountAvatarCreator,createAvatarPortrait} from './avatar-creator.js';
import {createMotion,advanceMotion,stopMotion,WALK_SPEED,FAST_WALK_MULTIPLIER} from './motion.js';
import {mountWorldInput} from './world-input.js';
import './editor.css';
import {createRenderer} from './renderer.js';
import {createBotEditor} from './bot-editor.js';
import './bot-editor.css';
import {navigationPolicy} from '../server/bot-navigation.mjs';
import {createBotMapInput} from './bot-map-input.js';
import {mountPersonalAreas} from './personal-areas.js';
import './personal-areas.css';
import {mountActionRuntime} from './action-runtime.js';
import {createContentWindowModality} from './content-window-modality.js';
import {createWindowControlStates} from './window-control-states.js';
import {createProximityControls} from './proximity-controls.js';
import {mountProximityControls} from './proximity-controls-ui.js';
import {createFollowMotionController} from './follow-motion.js';
import './proximity-controls.css';
import {createSurfaceHistory,surfaceLayers} from './surface-history.js';
import './action-runtime.css';
import {roomAllows} from './permissions.js';
import {canBuildInRoom,personalEditPolicy} from './personal-editor-policy.js';
import {mountEditor} from './editor.js';
import {mountSocial} from './social.js';
import './social.css';
import {mountExpress} from './express.js';
import './express.css';
import {mountPalette} from './command-palette.js';
import './command-palette.css';
import {mountPlaces} from './places.js';
import './places.css';
import {mountQuests} from './quests.js';
import {mountMedia} from './media.js';
import './media.css';
import {createHudAvailability} from './hud-availability.js';
import './hud-availability.css';
const $=id=>document.getElementById(id);
const updateHudAvailability=createHudAvailability($('app'),$('game'));
let areaActions,contentModality=null,syncWindowControls=()=>{},bootReady=false,lastSurfaceClosed=0;for(const id of ['join-form','login-form'])$(id).addEventListener('submit',event=>{if(!bootReady){event.preventDefault();event.stopImmediatePropagation();}});

const state={accessPolicy:{guestCreation:true,registration:true},user:null,worlds:[],universes:[],room:null,bots:[],botPermissions:{canManage:false},scene:clone(seedWorlds[0].rooms[0].scene),people:[],position:{x:0,z:7},direction:0,moving:false,ready:false,online:false,admissionId:null,admissionEpoch:null,admissionRevision:null,destination:null};
let dialogReturnFocus=null,imageLibrary=null,arrivalShare=null,catalogEpoch=0;
let motion=createMotion(state.position),worldInput=null,express=null,palette=null,avatarCreator=null,personalAreas=null,botEditor=null,botMapInput=null,botPreviewState=null,botPermissionEpoch=0,selectedAppearance=normalizeAppearance(0);
let navigating=false,reconcilingArrival=null,retainedEditorFocus=null,pendingNearbyContext=null,pendingGroupContext=null,nearbyUnread=0;
let groupControls=null,groupView=null,groupState=null,followResumeAt=0;
const followMotion=createFollowMotionController();
let renderer=null,editor=null,social=null,media=null,quests=null,places=null,events=null,keys=new Set(),path=[],pathSpeed=1,deskTargetId=null,joystick={x:0,z:0},building=false,presenceAt=0,presenceBusy=false,presenceInFlight=null,emote='',emoteUntil=0,nearby=null,currentAreas=new Set(),joinEpoch=0,lastTime=0,toastTimer=0,toastKind='',selectedWoka=0,unread=0,dragStart=null;
function surfaceVisible(name){return ({chat:()=>$('social').dataset.tab==='chat'&&!$('social').hidden,people:()=>$('social').dataset.tab==='people'&&!$('social').hidden,settings:()=>$('social').dataset.tab==='settings'&&!$('social').hidden,build:()=>building,'editor-review':()=>editor?.isReviewOpen?.(),dialog:()=>!$('dialog').hidden,images:()=>imageLibrary?.isOpen(),bots:()=>botEditor?.isOpen(),personal:()=>personalAreas?.isOpen(),avatar:()=>avatarCreator?.isOpen(),palette:()=>palette?.isOpen(),express:()=>express?.isOpen(),places:()=>places?.isOpen(),quests:()=>quests?.isOpen()})[name]?.()??false;}
const surfaceHistory=createSurfaceHistory({history,getRoom:()=>state.room?.id,getContent:()=>areaActions?.isOpen()?areaActions.historyKey():null,isVisible:surfaceVisible,getUrl:()=>location.href});
async function api(url,{method='GET',body,signal,deferRoomPreparation=false}={}){if(url==='/api/logout'&&botEditor?.isOpen()&&!await botEditor.close())throw Error('Save or discard your resident draft before signing out');const res=await fetch(url,{method,signal,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});let data;try{data=await res.json();}catch{data={message:'The server returned an unreadable response'};}if(!deferRoomPreparation&&res.ok&&data.room?.scene)imageLibrary?.prepareRoom(data.room,{preserve:!url.endsWith('/join')});if(!res.ok){const err=new Error(data.message||data.error?.message||data.error||'Request failed');err.status=res.status;err.data=data;throw err;}if(url==='/api/logout')imageLibrary?.suspend();return data;}
function toast(message,{kind='notice'}={}){toastKind=kind;$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('toast').hidden=true;toastKind='';},4300);}
function dismissFramingToast(){if(toastKind!=='framing')return;clearTimeout(toastTimer);$('toast').hidden=true;toastKind='';}
function normalizePeople(people){return (people||[]).map(p=>({...p,id:p.id||p.userId,name:p.name||p.displayName||'Guest',woka:p.woka??0}));}
function renderPeople(){if(!state.user)return;if(!state.ready){renderer?.syncPeople([]);return;}const others=state.people.filter(p=>p.id!==state.user.id);const bots=(state.bots||[]).filter(bot=>bot.id!==botPreviewState?.botId).map(bot=>({...bot,rotation:bot.heading}));renderer?.syncPeople([...others,...bots,{...state.user,...state.position,self:true,moving:state.moving,direction:state.direction,rotation:motion.heading,velocity:{...motion.velocity},running:motion.running,emote:emoteUntil>Date.now()?emote:''}]);$('people-count').textContent=String(others.length+1);}
function setScene(scene){state.scene=scene;renderer?.sync(scene);if(building&&editor?.getSelected())renderer?.select(editor.getSelected());updateAreas(true);}
function updateUnreadBadge(){const count=unread+nearbyUnread;$('unread').textContent=count>99?'99+':String(count);$('unread').hidden=count===0;}
function setOnline(ok){state.online=ok;$('connection').textContent='';const dot=document.createElement('i');$('connection').append(dot,document.createTextNode(ok?'Live room':'Reconnecting'));$('connection').className=ok?'live':'offline';}
function updateTitle(){if(!state.room){$('room-name').textContent='Find your place';$('world-name').textContent='UNIVERSE';$('room-subtitle').textContent='Choose a room or create a world';$('dock-build').disabled=true;document.title='Universe';return;}$('room-name').textContent=state.room.name;$('world-name').textContent=state.worlds.find(w=>w.id===state.room.worldId)?.name||'OUR UNIVERSE';$('room-subtitle').textContent=building?'A little imagination goes a long way':'A place to be together';$('dock-build').disabled=!state.ready||!renderer||!canBuildInRoom(state.room);$('dock-build').title=!renderer?'Building needs the 3D view':$('dock-build').disabled?'Ask the owner for editor access':'Build and edit this room';document.title=state.room.name+' · Universe';}
function getState(){return state;}
function applyArrival(decision){
 if(decision.kind==='adopt'){
  stopPlayer();followMotion.clear(motion,{path});
  Object.assign(state,{position:{...decision.pose},admissionId:decision.admissionId,admissionEpoch:decision.admissionEpoch,admissionRevision:decision.admissionRevision});
  motion=createMotion(state.position);
  if(state.room?.id===decision.roomId&&!navigating){currentAreas.clear();areaActions?.arrive(decision.roomId,state.scene,state.position);renderPeople();}
 }else if(decision.kind==='retain')Object.assign(state,{admissionId:decision.admissionId,admissionEpoch:decision.admissionEpoch,admissionRevision:decision.admissionRevision});
}
function loseArrivalAuthority(reason){
 if(['no-current-room','source-access-changed'].includes(reason)&&state.room){retireRoomAccess();return;}
 state.ready=false;state.admissionId=null;state.admissionEpoch=null;state.admissionRevision=null;
 stopPlayer();followMotion.clear(motion,{path});areaActions?.clear();arrivalShare?.cancel();imageLibrary?.suspend();groupControls?.syncState();
 renderer?.syncPeople([]);social?.resetNearbyConnection('arrival-unconfirmed');media?.update();
 if(reason==='authentication-required'){events?.close();events=null;setOnline(false);$('welcome').hidden=false;}
}
function writeDestination(destination,historyMode='replace'){
 const url=writeTravelLocation(location.href,destination);
 history[historyMode==='push'?'pushState':'replaceState']({room:destination.roomId,...(destination.entry===undefined?{}:{entry:destination.entry})},'',url);
 state.destination={...destination};
}
function retireTravelEffects(){arrivalShare?.cancel();areaActions?.clear();quests?.cancelWalk();imageLibrary?.suspend();}
const arrivalNavigation=createArrivalNavigation({api,getContext:()=>({accountId:state.user?.id,roomId:state.room?.id}),
 beforeStart:async(destination,options)=>{
  if(options.reconcile)return true;
  if(editor?.isSaving())throw Error('Wait for this room to finish saving before travelling');
  if(botEditor?.isOpen()&&!await botEditor.close())throw Error('Save or discard your resident draft before travelling');
  if(editor?.isDirty()&&!window.confirm('You have unsaved room edits. Leave without saving?')){if(state.destination)writeDestination(state.destination);return false;}
  if(options.savedArrival){const saved=options.savedArrival;if(!building||editor.isDirty()||editor.isSaving()||state.room?.id!==saved.roomId||state.room.revision!==saved.revision||editor.getSelected()!==saved.areaId||!roomAllows(state.room,'canEditScene')||state.room.scene.areas.find(area=>area.id===saved.areaId)?.start?.key!==saved.entry)throw Error('Select the saved arrival in the current clean room before trying it.');}
  return true;
 },
 onBegin:(_destination,options)=>{
  const focused=document.activeElement;retainedEditorFocus=(options.reconcile||options.mode==='resume')&&$('editor').contains(focused)?{node:focused,value:focused.value,start:focused.selectionStart,end:focused.selectionEnd}:null;
  joinEpoch++;navigating=true;$('editor').inert=true;pendingNearbyContext=null;pendingGroupContext=null;
  groupControls?.syncState();followMotion.clear(motion,{path});social?.resetNearbyConnection('travelling');social?.render();
  stopPlayer();if(!options.reconcile&&options.mode!=='resume')retireTravelEffects();
 },
 onRetained:buffered=>{for(const event of buffered.toSorted((a,b)=>(a.data.room?.revision??Infinity)-(b.data.room?.revision??Infinity)))handleEvent(event);},
 onDecision:applyArrival,onAuthorityLost:loseArrivalAuthority,onError:error=>toast(error.message),
 onCommit:({result,decision,destination,options,events:buffered})=>{
  const sameRoomResume=(options.reconcile||options.mode==='resume')&&result.room.id===state.room?.id;
  const retained=sameRoomResume&&decision.kind==='retain';
  const recoverDraft=sameRoomResume&&!retained&&editor?.isDirty();
  const keptEditor=retained||recoverDraft;
  if(keptEditor){
   if(!retained){retireTravelEffects();editor.closeReview?.({record:false,restore:false});}
   // The new pose/admission is already authorized. Retire old save callbacks,
   // but retain local work across a same-room process restart or expired pose.
   applyArrival(decision);state.ready=true;
   media?.acceptCommittedRoom(result.room,state.user.id);
   imageLibrary?.receiveRoom(result.room);editor.cancelGesture();
   if(recoverDraft){if(!editor.resumeAdmission?.(result.room)){retireRoomAccess('Your room connection changed. Keep a copy of your draft before opening it again.');return;}}
   else editor.receiveScene(result.room);
   const {scene:_scene,revision:_revision,...metadata}=result.room;Object.assign(state.room,metadata);
   imageLibrary?.acceptRoom();
   if(!retained){currentAreas.clear();areaActions?.arrive(state.room.id,state.scene,state.position);}
   if(building&&!canBuildInRoom(state.room)){toggleBuild(false,{record:false});if(editor.isDirty())showDialog({eyebrow:'EDITOR ACCESS CHANGED',title:'Keep a copy of your work',text:'Your editor access was removed. You can export the unsaved draft before leaving this room.',actions:[{label:'Export my draft',run:()=>editor.exportScene()}]});}
  }else{
  retireTravelEffects();building=false;$('editor').hidden=true;$('quest-open').hidden=false;$('dock-build').classList.remove('active');
  // Snapshot preparation and pose adoption are both fenced here, after HTTP and
  // buffered authorization/scene events agree. No local spawn sampler runs.
  imageLibrary?.prepareRoom(result.room,{preserve:false});state.room=result.room;state.scene=clone(result.room.scene);
  applyArrival(decision);currentAreas.clear();areaActions?.arrive(state.room.id,state.scene,state.position);state.ready=true;imageLibrary?.acceptRoom();
  renderer?.sync(state.scene);renderer?.setBuild(false);editor.attachRoom();editor.setBuild(false);
  }
  state.people=normalizePeople(result.presence);state.bots=result.bots||[];state.botPermissions=result.botPermissions||{canManage:false};
  for(const member of result.members||[]){const person=state.people.find(p=>p.id===member.id);if(person)Object.assign(person,{role:member.role,tags:member.tags||[],mutedUntil:member.mutedUntil});}
  updateTitle();renderPeople();social.render();media.update();
  for(const event of buffered)if(event.type==='media-policy')media.onEvent(event);
  refreshBotPermissions();quests?.refresh();setOnline(true);$('welcome').hidden=true;
  const preserved=options.reconcile&&state.destination?.roomId===destination.roomId?state.destination:destination;
  if(!keptEditor)writeDestination(preserved,options.reconcile?'replace':options.historyMode||'push');
  if(result.arrival?.fallback==='unknown-entry')toast('That named arrival is no longer available. You arrived at this room’s default.');
  if(!keptEditor)$('game').focus();
 },
 onSettled:async({current,options,failed,committed})=>{
  if(!current)return;
  const epoch=joinEpoch,accountId=state.user?.id;
  const controls=options.initialControls??await api('/api/proximity-controls').catch(()=>null);
  if(epoch!==joinEpoch||accountId!==state.user?.id)return;
  navigating=false;$('editor').inert=false;
  const focus=retainedEditorFocus;retainedEditorFocus=null;if(focus?.node.isConnected&&!$('editor').hidden&&!focus.node.disabled&&focus.node.getClientRects().length&&(document.activeElement===document.body||document.activeElement===focus.node)){focus.node.focus({preventScroll:true});if(Number.isInteger(focus.start)&&focus.node.value===focus.value)focus.node.setSelectionRange(focus.start,focus.end);}
  if(failed&&!committed&&state.ready){const accepted=arrivalNavigation.snapshot().current;if(accepted?.roomId===state.room?.id&&accepted.admissionId===state.admissionId&&accepted.admissionEpoch===state.admissionEpoch&&accepted.admissionRevision===state.admissionRevision){imageLibrary?.resume();areaActions?.arrive(state.room.id,state.scene,state.position);}if(state.destination)writeDestination(state.destination);}groupControls?.syncState();if(controls)groupControls?.acceptContext(controls,{readOnly:true});
  if(pendingGroupContext){const pending=pendingGroupContext;pendingGroupContext=null;groupControls?.onEvent(pending);}
  syncGroupState();mirrorControlledAvatar();social?.render();
  if(pendingNearbyContext){const pending=pendingNearbyContext;pendingNearbyContext=null;social?.onEvent(pending);}
  if(state.ready){updateAreas(true);void sendPresence(true);}else updateTitle();
 }
});
function joinRoom(id,options={}){return arrivalNavigation.navigate(id,options);}
function reconcileArrival(){
 if(reconcilingArrival||!state.user)return reconcilingArrival;
 // Reads session authority inside the serialized operation, so a sibling's
 // different-room travel cannot be undone by an automatic resume.
 const request=joinRoom(state.room?.id||'commons',{mode:'resume',reconcile:true,historyMode:'replace'});
 reconcilingArrival=request;request.catch(()=>{}).finally(()=>{if(reconcilingArrival===request)reconcilingArrival=null;});return request;
}
async function loadSession(session){
 imageLibrary?.suspend();state.ready=false;state.admissionId=null;state.admissionEpoch=null;state.admissionRevision=null;
 if(state.user?.id!==session.user?.id){state.room=null;state.destination=null;state.scene=clone(seedWorlds[0].rooms[0].scene);renderer?.sync(state.scene);}
 state.user=session.user;state.worlds=session.worlds||[];state.universes=session.universes||[];
 if(!state.worlds.length){const res=await api('/api/worlds');state.worlds=res.worlds;}
 let desired;try{desired=readTravelLocation(location.href);}catch(error){toast(error.message);desired={roomId:null};}
 const room=desired.roomId||session.currentRoomId||'commons';
 // Reload preserves the current admission, including an entry-bearing URL.
 // Explicit same-room travel and Back/Forward use mode travel instead.
 const mode=initialArrivalMode({...desired,roomId:room},session.currentRoomId);
 connectEvents();let admitted=false;
 try{await joinRoom(room,{historyMode:'replace',invite:desired.invite,entry:desired.entry,mode});admitted=state.ready;}catch{}
 if(!admitted){state.ready=false;imageLibrary?.suspend();state.people=[];$('welcome').hidden=true;renderer?.syncPeople([]);updateTitle();places?.open(desired.invite?'invitations':'explore');}
}
function connectEvents(){
 events?.close();pendingNearbyContext=null;pendingGroupContext=null;groupControls?.resetConnection('connecting');followMotion.clear(motion,{path});social?.resetNearbyConnection('connecting');
 // Allocate/reset source scope before constructing the stream or issuing joins.
 const eventActorId=state.user?.id,sourceGeneration=arrivalNavigation.reset(),source=new EventSource('/api/events');events=source;let streamOpen=false;
 const isCurrent=()=>events===source&&eventActorId===state.user?.id;
 source.onopen=()=>{if(!isCurrent())return;streamOpen=true;pendingNearbyContext=null;pendingGroupContext=null;groupControls?.resetConnection('connecting');followMotion.clear(motion,{path});social?.resetNearbyConnection('connecting');setOnline(true);if(state.room&&!navigating)void reconcileArrival();};
 source.onerror=()=>{if(!isCurrent())return;streamOpen=false;pendingNearbyContext=null;pendingGroupContext=null;groupControls?.resetConnection('disconnected');followMotion.clear(motion,{path});social?.resetNearbyConnection('disconnected');setOnline(false);};
 for(const type of ['hello','presence','scene','message','dm','members','role','room','moderation','media-policy','media-signal','quest','catalog','access-revoked','membership','invitation','expression','expression-clear','bots','image-assets','proximity-text-context','proximity-text-message','proximity-typing','proximity-controls'])source.addEventListener(type,event=>{
  if(!isCurrent()||!streamOpen)return;let data;try{data=JSON.parse(event.data);}catch{return;}
  if(type==='hello'){
   const decision=arrivalNavigation.hello(data.arrivalEpoch,sourceGeneration);
   // Arrival fencing runs first, but every current transport hello must still
   // reach consumers (including Nearby typing's server-clock anchor).
   handleEvent({type,data,actorId:eventActorId});
   if(decision.kind==='refresh-required'&&!navigating)void reconcileArrival();return;
  }
  const envelope={type,data,actorId:eventActorId};const observation=arrivalNavigation.observe(envelope,sourceGeneration);
  if(observation.decision?.kind==='refresh-required'&&!navigating)void reconcileArrival();
  if(observation.buffered&&data.roomId===state.room?.id){
   // A retained source can accept deny-only committed media geometry even
   // while its resume response is held; its dirty editor draft is untouched.
   if(type==='scene'&&data.room)media?.acceptCommittedRoom(data.room,eventActorId);
   if(type==='media-policy')media?.onEvent(envelope);
   if(type==='access-revoked'||type==='moderation'&&['kick','ban','deleted'].includes(data.action)&&(data.userId===state.user?.id||data.action==='deleted'))handleEvent(envelope);
  }else if(!observation.buffered)handleEvent(envelope);
 });
}
async function refreshCatalog(){if(!state.user)return;const epoch=++catalogEpoch,accountId=state.user.id;try{const data=await api('/api/worlds');if(epoch!==catalogEpoch||accountId!==state.user?.id)return;state.worlds=data.worlds||[];if(data.universes)state.universes=data.universes;updateTitle();social.render();places?.refresh();}catch(error){if(epoch===catalogEpoch&&error.status!==401)toast('The place directory could not refresh. Try again.');}}
function retireRoomAccess(reason){
 if(!state.room)return;
 // Finish local field edits before retiring the room. The recovery copy belongs
 // to this draft even after the current-room metadata and authority are cleared.
 if(building)toggleBuild(false,{record:false});else editor?.setBuild(false);
 const roomId=state.room.id,draft=editor?.isDirty()?JSON.stringify({format:'universe-room',version:1,name:state.room.name,scene:state.scene},null,2):null;
 loseArrivalAuthority();pendingNearbyContext=null;pendingGroupContext=null;state.people=[];state.bots=[];state.botPermissions={canManage:false};botEditor?.updateAuthority(false);personalAreas?.clear();quests?.cancelWalk();
 state.room=null;state.destination=null;state.worlds=[];state.universes=[];catalogEpoch++;
 $('interaction').hidden=true;nearby=null;currentAreas.clear();media?.update();quests?.refresh();updateTitle();social?.render();palette?.refresh();
 const actions=[];
 if(draft)actions.push({label:'Export my unsaved draft',run:()=>{const url=URL.createObjectURL(new Blob([draft],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=roomId+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}});
 actions.push({label:'Browse accessible places',run:()=>places?.open('explore')});
 showDialog({eyebrow:'ROOM ACCESS CHANGED',title:'You’ve left this room',text:reason||'Your room admission ended. Your draft is kept so you can save a copy.',actions});
 void refreshCatalog();
}
function handleEvent(event){const {type,data}=event;if(type==='proximity-controls'){if(navigating)pendingGroupContext=event;else groupControls?.onEvent(event);return;}if(type==='proximity-text-context'||type==='proximity-text-message'||type==='proximity-typing'){if(navigating){if(type==='proximity-text-context')pendingNearbyContext=event;return;}social?.onEvent(event);return;}const thisRoom=!data.roomId||data.roomId===state.room?.id;if(type==='presence'&&thisRoom){state.people=normalizePeople(data.presence);mirrorControlledAvatar();renderPeople();}
 if(type==='catalog')refreshCatalog();if(type==='invitation'&&!places?.isOpen()){$('places-alert').hidden=false;}
 if(type==='access-revoked'&&thisRoom)retireRoomAccess(data.reason);
 if(type==='bots'&&thisRoom){state.bots=data.bots||[];renderPeople();}
 if(type==='image-assets'&&thisRoom&&state.ready){editor?.cancelGesture();imageLibrary?.refresh(data);const epoch=joinEpoch,accountId=state.user?.id,roomId=state.room.id;api('/api/rooms/'+encodeURIComponent(roomId),{deferRoomPreparation:true}).then(result=>{if(epoch!==joinEpoch||accountId!==state.user?.id||roomId!==state.room?.id||!state.ready)return;imageLibrary?.receiveRoom(result.room);renderer?.sync(state.scene);}).catch(()=>{});}
 if(type==='scene'&&thisRoom&&state.ready){media?.acceptCommittedRoom(data.room,event.actorId);imageLibrary?.receiveRoom(data.room);editor.cancelGesture();editor.receiveScene(data.room);imageLibrary?.syncAuthority();updateTitle();}
 if(type==='members'&&thisRoom){for(const member of data.members||[]){const person=state.people.find(p=>p.id===(member.id||member.userId));if(person)Object.assign(person,{role:member.role,mutedUntil:member.mutedUntil});}}
 if(type==='role'&&thisRoom){state.room.role=data.role;state.room.capabilities=data.capabilities||data.room?.capabilities;if(data.room?.personalAreas)state.room.personalAreas=data.room.personalAreas;editor.cancelGesture();if(data.room?.scene){imageLibrary?.receiveRoom(data.room);editor.receiveScene(data.room);}imageLibrary?.syncAuthority();if(building&&!canBuildInRoom(state.room)){toggleBuild(false,{record:false});if(editor.isDirty())showDialog({eyebrow:'EDITOR ACCESS CHANGED',title:'Keep a copy of your work',text:'Your editor access was removed. You can export the unsaved draft before leaving this room.',actions:[{label:'Export my draft',run:()=>editor.exportScene()}]});else toast('Your editor access changed');}updateTitle();}
 if(type==='room'&&thisRoom&&data.room){if(data.room.scene)imageLibrary?.receiveRoom(data.room);state.room={...state.room,...data.room};imageLibrary?.syncAuthority();updateTitle();}
 if(type==='moderation'&&thisRoom&&['kick','ban','deleted'].includes(data.action)&&(data.userId===state.user?.id||data.action==='deleted')){state.ready=false;groupControls?.syncState();followMotion.clear(motion,{path});pendingNearbyContext=null;social?.resetNearbyConnection('access-changed');imageLibrary?.suspend();path=[];state.people=[];renderer?.syncPeople([]);toast('You left this room: '+data.action);social.setTab('explore');}
 if((type==='message'&&thisRoom||type==='dm')&&data.message?.author?.id!==state.user?.id&&($('social').hidden||$('social').inert)){unread++;updateUnreadBadge();}
 social.onEvent(event);media.onEvent(event);quests?.onEvent(event);places?.onEvent(event);express?.onEvent(event);if(['presence','catalog','role'].includes(type))palette?.refresh();if(['role','catalog','membership'].includes(type))refreshBotPermissions();}
function rememberSurface(surface,{nested=false}={}){if(!state.user)return;if(surface!=='images'&&imageLibrary?.isOpen())imageLibrary.setOpen(false,{record:false});surfaceHistory.remember(surface,{nested});syncContentWindows();}
function dismissSurface(surface){surfaceHistory.dismiss(surface);syncContentWindows();}
function togglePanel(tab){if(!state.user)return;if(tab!=='explore'&&contentMaximized())areaActions.setWindowMaximized(false);if(botEditor?.isOpen())return botEditor.close().then(ok=>ok&&togglePanel(tab));stopPlayer();if(tab==='explore'){if(places?.isOpen())places.close();else places?.open('explore');return;}const same=$('social').dataset.tab===tab&&!$('social').hidden;if(same){$('social').hidden=true;clearActive();dismissSurface(tab);return;}if(building)toggleBuild(false,{record:false});if(places?.isOpen())places.close();$('social').hidden=false;social.setTab(tab);rememberSurface(tab);clearActive();$('dock-'+tab)?.classList.add('active');if(tab==='chat'){unread=0;updateUnreadBadge();}}
function clearActive(){for(const b of document.querySelectorAll('#dock [data-panel]'))b.classList.remove('active');}
function toggleBuild(force,{record=true}={}){if(force!==true&&record&&editor?.isReviewOpen?.()){editor.closeReview();return;}if(force!==false&&contentMaximized())areaActions.setWindowMaximized(false);if(force===false&&imageLibrary?.isOpen()&&record){imageLibrary.setOpen(false);return;}if(force!==false&&botEditor?.isOpen())return botEditor.close().then(ok=>ok&&toggleBuild(force,{record}));stopPlayer();if(force!==false&&!renderer){toast('3D building is unavailable in this browser');return;}if(force!==false&&(!state.ready||!state.room||!canBuildInRoom(state.room))){toast('The room owner can grant you editor access');return;}if(force===false||force===undefined&&building)editor?.closeReview?.({record:false});building=force??!building;if(record){if(building)rememberSurface('build');else dismissSurface('build');}$('editor').hidden=!building;$('quest-open').hidden=building;$('dock-build').classList.toggle('active',building);$('room-subtitle').textContent=building?'A little imagination goes a long way':'A place to be together';if(building){if(places?.isOpen())places.close();$('social').hidden=true;clearActive();path=[];keys.clear();editor.attachRoom();}renderer?.setBuild(building);editor.setBuild(building);if(building&&editor.getSelected())renderer?.select(editor.getSelected());}
function showDialog({eyebrow,title,text,actions=[],owner=''}){$('dialog').dataset.actionOwner=owner;if($('dialog').hidden)dialogReturnFocus=document.activeElement;rememberSurface('dialog',{nested:true});$('dialog-eyebrow').textContent=eyebrow||'UNIVERSE';$('dialog-title').textContent=title;$('dialog-content').textContent=text||'';$('dialog-actions').replaceChildren();for(const action of actions){const b=document.createElement('button');b.className='primary';b.textContent=action.label;if(action.description){b.classList.add('room-action-button');const detail=document.createElement('small');detail.textContent=action.description;b.append(detail);}b.onclick=()=>{closeDialog(false);history.replaceState({room:state.room?.id},'',location.href);action.run();};$('dialog-actions').append(b);}$('dialog').hidden=false;syncContentWindows();stopPlayer();$('dialog-close').focus();}
function closeDialog(record=true){if($('dialog').dataset.actionOwner==='share-arrival')arrivalShare?.cancel();$('dialog').hidden=true;lastSurfaceClosed=performance.now();if(record)dismissSurface('dialog');const target=dialogReturnFocus?.isConnected&&dialogReturnFocus.getClientRects().length?dialogReturnFocus:$('game');target.focus();}
function openUrl(url){try{const u=new URL(url,location.origin);if(!['https:','http:'].includes(u.protocol))throw Error();window.open(u.href,'_blank','noopener,noreferrer');}catch{toast('This item needs a valid http or https address');}}
function interact(o=nearby){if(!o)return;if(o.target&&!Array.isArray(o.actions)){areaActions?.activate({roomId:state.room.id,entityType:'item',entityId:o.id,actionId:'legacy-target'},{deliberate:true});return;}areaActions?.openItem(o.id);}
function updateAreas(force=false){if(navigating||!state.admissionId)return;media?.checkLocalPolicy();if(!state.scene||!state.user)return;const active=state.scene.areas.filter(a=>contains(a,state.position.x,state.position.z));const next=new Set(active.map(a=>a.id));
 areaActions?.update({suppressed:building||!!botEditor?.isOpen()||!state.ready||!state.online});personalAreas?.update({suppressed:building||!!botEditor?.isOpen()||modalOpen()||!$('social').hidden||!$('media').hidden||isTyping()});currentAreas=next;const area=activeMediaArea(active);$('area-banner').hidden=!area||building;if(area){$('area-name').textContent=mediaAreaLabel(area);$('area-message').textContent=mediaAreaMessage(area);}
 const useable=state.scene.objects.filter(o=>areaActions?.hasActions(o)||o.text||['screen','board','portal'].includes(o.type));nearby=useable.filter(o=>Math.hypot(o.x-state.position.x,o.z-state.position.z)<2.4).sort((a,b)=>Math.hypot(a.x-state.position.x,a.z-state.position.z)-Math.hypot(b.x-state.position.x,b.z-state.position.z))[0];$('interaction').hidden=!nearby||building||!$('dialog').hidden;if(nearby){$('interaction-label').textContent=nearby.name;$('interact').textContent=nearby.target?'Space · Travel':'Space · Open';}}
async function sendPresence(force=false){
 if(!state.ready||!state.user||!state.room||!state.admissionId||navigating||groupState?.followingReadOnly)return false;
 if(presenceInFlight){if(!force)return false;while(presenceInFlight)await presenceInFlight;}
 if(!state.ready||!state.room||!state.admissionId||navigating||groupState?.followingReadOnly)return false;
 const now=performance.now();if(!force&&now-presenceAt<(state.moving?100:1200))return false;
 presenceAt=now;const roomId=state.room.id,admissionId=state.admissionId,payload={roomId,admissionId,...state.position,moving:state.moving,running:motion.running,velocity:{...motion.velocity},direction:state.direction,rotation:motion.heading,emote:emoteUntil>Date.now()?emote:null};
 const control=groupState?.context;if(control?.roomId===roomId&&control.connectionId&&control.following?.controlling&&control.following.leaseId){payload.connectionId=control.connectionId;payload.followLeaseId=control.following.leaseId;}
 const operation=(async()=>{try{await api('/api/presence',{method:'POST',body:payload});return true;}catch(e){if(roomId===state.room?.id&&admissionId===state.admissionId){if(e.status===409&&['STALE_ARRIVAL','POSITION_UNCONFIRMED'].includes(e.data?.error)){loseArrivalAuthority();void reconcileArrival();}else if(e.status===401){state.ready=false;imageLibrary?.suspend();$('welcome').hidden=false;}else if(e.status===409&&['FOLLOW_CONTROLLED_ELSEWHERE','STALE_FOLLOW_LEASE','STALE_CONTROL_MOVEMENT'].includes(e.data?.error)){void groupControls?.refresh({readOnly:!groupState?.context?.connectionId});}else if(e.status!==429)setOnline(false);}return false;}})();
 presenceInFlight=operation;try{return await operation;}finally{if(presenceInFlight===operation)presenceInFlight=null;}
}
function socialFollowShortcut(){const pendingOnly=groupState?.invitations?.length&&!groupState.context?.following&&!groupState.leading&&!groupState.stopUnconfirmed&&!['accept','invite'].includes(groupState.operation?.action);if(!pendingOnly)void groupControls?.followAction();}
function groupContext(){return {roomId:state.room?.id,connectionId:groupState?.context?.connectionId,memberId:groupState?.context?.memberId};}
function syncGroupState(){
 if(!groupControls)return;const previous=groupState;groupState=groupControls.snapshot();
 if(previous?.motion?.leaseId&&previous.motion.leaseId!==groupState.motion?.leaseId){followMotion.clear(motion,{path});stopPlayer();}
 if(groupState.motion?.leaseId&&groupState.motion.leaseId!==previous?.motion?.leaseId){followMotion.clear(motion,{path});stopPlayer();if($('proximity-controls')?.contains(document.activeElement))$('game').focus({preventScroll:true});}
 if(!!groupState.followingReadOnly!==!!previous?.followingReadOnly)stopPlayer();
}
function mirrorControlledAvatar(){
 if(!groupState?.followingReadOnly||!state.ready||navigating)return false;
 const person=state.people.find(person=>person.id===state.user?.id);if(!person||person.admissionId!==state.admissionId||person.admissionEpoch!==state.admissionEpoch||person.admissionRevision!==state.admissionRevision||!Number.isFinite(person.x)||!Number.isFinite(person.z))return true;
 state.position={x:person.x,z:person.z};motion.position={...state.position};motion.heading=Number.isFinite(person.rotation)?person.rotation:motion.heading;
 const connected=groupState.context?.following?.controllerConnected===true;motion.velocity={x:connected&&Number.isFinite(person.velocity?.x)?person.velocity.x:0,z:connected&&Number.isFinite(person.velocity?.z)?person.velocity.z:0};motion.running=connected&&!!person.running;state.moving=connected&&!!person.moving;state.direction=person.direction??state.direction;return true;
}
function followBlocked(){return !state.ready||!state.online||navigating||building||!!botEditor?.isOpen()||modalOpen()||isTyping()||!$('social').hidden||!$('media').hidden||document.hidden||!document.hasFocus()||!!groupState?.followingReadOnly;}
function refreshFollowMotion(){
 if(!groupState?.motion||followBlocked()||followMotion.snapshot().pending||performance.now()<followResumeAt)return;
 const ticket=followMotion.beginResume();void groupControls.refresh().then(ok=>{syncGroupState();if(followBlocked()){followMotion.pause(motion,{path});return;}if(!ok){if(followMotion.rejectResume(ticket))followResumeAt=performance.now()+1000;return;}if(!followMotion.resume(ticket,groupState?.motion??null,groupContext()))followResumeAt=performance.now()+1000;else followResumeAt=0;});
}
function syncGroupPresentation(){
 const root=$('proximity-controls');if(!root)return;
 const covered=building||!!botEditor?.isOpen()||modalOpen()||!$('social').hidden||!$('media').hidden;
 root.inert=covered;const value=String(covered);if(root.dataset.obscured!==value)root.dataset.obscured=value;
 if(!root.hidden&&!covered){const base=Number.parseFloat(getComputedStyle(root).getPropertyValue('--proximity-base-bottom'))||112;const target=$('interaction'),bounds=!target.hidden?target.getBoundingClientRect():null;const bottom=Math.min(innerHeight-64,Math.max(base,bounds?innerHeight-bounds.top+8:0));const size=bottom+'px';if(root.style.getPropertyValue('--proximity-bottom')!==size)root.style.setProperty('--proximity-bottom',size);const height=Math.max(56,innerHeight-bottom-12)+'px';if(root.style.getPropertyValue('--proximity-max-height')!==height)root.style.setProperty('--proximity-max-height',height);}
}
function isTyping(){return imageLibrary?.hasFocus()||areaActions?.hasFocus()||/INPUT|TEXTAREA|SELECT|IFRAME/.test(document.activeElement?.tagName)||document.activeElement?.isContentEditable;}
function stopPlayer({cancelPath=true}={}){keys.clear();joystick={x:0,z:0};stopMotion(motion);state.moving=false;if(cancelPath){path=[];pathSpeed=1;deskTargetId=null;renderer?.setDestination(null);}worldInput?.cancel();}
function modalOpen(){return !!(editor?.isReviewOpen?.()||contentMaximized()||imageLibrary?.isOpen()||personalAreas?.isOpen()||quests?.isOpen()||places?.isOpen()||avatarCreator?.isOpen()||express?.isOpen()||palette?.isOpen()||!$('dialog').hidden||!$('welcome').hidden);}
function contentMaximized(){const window=areaActions?.windowState();return !!(window?.open&&window.maximized);}
function contentCoversViewport(){const window=areaActions?.windowState();return !!(window?.open&&window.width>=Math.min(innerWidth,$('game').getBoundingClientRect().width)-1);}
function contentHasHigherSurface(){return !!(editor?.isReviewOpen?.()||imageLibrary?.isOpen()||personalAreas?.isOpen()||quests?.isOpen()||places?.isOpen()||avatarCreator?.isOpen()||express?.isOpen()||palette?.isOpen()||botEditor?.isOpen()||!$('dialog').hidden||!$('welcome').hidden||!$('fallback').hidden);}
function syncContentWindows(){
 contentModality?.sync();syncWindowControls();
 const covered=String(contentMaximized());if($('express').dataset.contentCover!==covered)$('express').dataset.contentCover=covered;
}
function walkTo(point){if(!state.ready||building||modalOpen()||groupState?.followingReadOnly)return;const destination=nearestWalkable(state.scene,point);pathSpeed=1;deskTargetId=null;$('game').focus();path=findPath(state.scene,state.position,destination);if(path.length){renderer?.setDestination(destination);}else toast('That spot is not reachable. Try a clear patch of ground.');}
let lastFramingStatus='';
function update(dt,actualDt=dt){syncGroupState();syncContentWindows();syncGroupPresentation();if(contentCoversViewport())dismissFramingToast();if(deskTargetId&&!(state.room?.personalAreas||[]).some(area=>area.areaId===deskTargetId&&area.isOwner)){stopPlayer();toast('Your desk assignment changed');}
 quests?.setSuppressed(modalOpen()||building||!$('social').hidden||!$('media').hidden||isTyping());
 const observing=mirrorControlledAvatar(),pausedFollow=!!groupState?.motion&&followBlocked();if(pausedFollow)followMotion.pause(motion,{path});
 if(renderer&&state.ready&&!navigating&&!building&&!botEditor?.isOpen()&&!modalOpen()&&!isTyping()&&!observing&&!pausedFollow){
  const input={x:(keys.has('d')||keys.has('ArrowRight')?1:0)-(keys.has('a')||keys.has('ArrowLeft')?1:0)+joystick.x,z:(keys.has('s')||keys.has('ArrowDown')?1:0)-(keys.has('w')||keys.has('ArrowUp')?1:0)+joystick.z};
  if(Math.hypot(input.x,input.z)>.065&&quests?.isWalking?.())quests.cancelWalk();
  const hadPath=path.length>0;motion.position={...state.position};
  if(groupState?.motion){if(!followMotion.snapshot().armed)refreshFollowMotion();const result=followMotion.advance(motion,state.scene,{grant:groupState.motion,context:groupContext(),input,angle:renderer.getCameraAngle(),fast:keys.has('Shift'),path,pathSpeed,followSpeedLimited:groupState.followSpeedLimited},actualDt);if(result.stopFollow&&groupState.motion?.leaseId===result.stopFollow.leaseId)void groupControls.stop();}
  else{if(followMotion.snapshot().paused||followMotion.snapshot().armed||followMotion.snapshot().pending){const ticket=followMotion.beginResume();followMotion.resume(ticket,null,groupContext());}advanceMotion(motion,state.scene,{input,angle:renderer.getCameraAngle(),fast:keys.has('Shift')&&!groupState?.followSpeedLimited,path,pathSpeed},actualDt);}
  state.position={...motion.position};state.moving=motion.moving;state.direction=motion.direction;
  if(hadPath&&!path.length)renderer.setDestination(null);updateAreas();
 }else if(!observing){stopMotion(motion);state.moving=false;}
 updateHudAvailability();renderPeople();renderer?.setTarget(state.position.x,state.position.z);renderer?.render(Math.min(.1,dt),actualDt);express?.update(performance.now());sendPresence();$('coords').textContent=state.position.x.toFixed(1)+' / '+state.position.z.toFixed(1);
 if(renderer&&$('camera-follow')){const camera=renderer.getCameraState();$('camera-follow').setAttribute('aria-pressed',String(camera.follow));if(camera.framing.status==='insufficient-space'&&lastFramingStatus!=='insufficient-space'&&!contentCoversViewport())toast('Not enough visible map space to frame the character. Close a panel or enlarge the window.',{kind:'framing'});lastFramingStatus=camera.framing.status;}
}
function loop(time){const actualDt=(time-lastTime)/1000||.016;lastTime=time;update(actualDt,actualDt);requestAnimationFrame(loop);}
function showShortcuts(){showDialog({eyebrow:'EVERYTHING AT YOUR FINGERTIPS',title:'Make yourself at home',text:'Move · WASD / ZQSD / arrows\nFast walk · hold Shift (2.5×)\nExpress / Think · Enter / Ctrl Enter\nChat / People / Explore · C / U / G\nBuild · E (B also works)\nInteract · Space\nRotate your character · R\nFavourite reactions · 1–6\nQuests / Profile / Connect / Bots · J / P / M / N\nPersonal spaces · L\nPersonal desk · Cmd/Ctrl D\nQuick actions · Cmd K / Ctrl K\nNearby · F invite/stop following (never Accept)\nCamera · drag to orbit, wheel to zoom\nCamera keys · [ ] orbit, Page Up/Down tilt, + − zoom, Shift F follow camera, Home reset\nPan · middle-drag, Shift right-drag, or Pan + arrows\nTouch camera · two fingers orbit/pinch; three fingers pan\nBuild · arrows move preview, Space place, R rotate, D duplicate, V select, X erase, Delete remove\nBuild history · Cmd/Ctrl Z undo, Shift Z redo, Cmd/Ctrl S save\nTab / Shift Tab focuses every control. Enter / Space activates it. Escape steps back.\nShortcuts stay out of text fields and composition.'});}
async function refreshBotPermissions(){const roomId=state.room?.id,epoch=++botPermissionEpoch;if(!roomId)return;try{const result=await api('/api/rooms/'+roomId+'/bot-permissions');if(epoch!==botPermissionEpoch||state.room?.id!==roomId)return;state.botPermissions=result;}catch{if(epoch!==botPermissionEpoch)return;state.botPermissions={canManage:false};}if($('manage-bots'))$('manage-bots').hidden=!state.ready||!state.botPermissions.canManage;if(botEditor?.isOpen())botEditor.updateAuthority(state.botPermissions.canManage);palette?.refresh();}
function suggestedBotSpawn(){const valid=navigationPolicy(state.scene,{spawn:state.position,radius:100,restrictedAreaIds:[]});const occupied=[...state.people,...state.bots,state.position];for(const radius of [2.5,3.5,4.5,6])for(let i=0;i<12;i++){const p={x:Math.round((state.position.x+Math.cos(i*Math.PI/6)*radius)*2)/2,z:Math.round((state.position.z+Math.sin(i*Math.PI/6)*radius)*2)/2};if(valid(p)&&!occupied.some(other=>Math.hypot(other.x-p.x,other.z-p.z)<1.2))return p;}return state.scene.spawn;}
async function openImageLibrary({record=true}={}){if(!state.ready)return;if(botEditor?.isOpen()&&!await botEditor.close())return;stopPlayer();editor?.cancelGesture();if(places?.isOpen())places.close();if(quests?.isOpen())quests.close();$('social').hidden=true;clearActive();imageLibrary?.syncAuthority();imageLibrary?.setOpen(true,{trigger:document.activeElement,record});}
async function openBots(id){if(!state.ready||!state.botPermissions.canManage){toast('A universe owner or world editor can manage residents');return;}if(botEditor?.isOpen()&&!id){await botEditor.close();return;}if(editor.isDirty()){toast('Save this room before opening resident authoring');return;}stopPlayer();if(building)toggleBuild(false,{record:false});rememberSurface('bots');await botEditor.open({...state.room,suggestedBotSpawn:suggestedBotSpawn()});if(id)await botEditor.select(id);}
async function openPersonalAreas(){if(botEditor?.isOpen()&&!await botEditor.close())return;personalAreas?.open();}
async function walkToDesk(){if(!state.ready)return;if(groupState?.followingReadOnly){toast('This avatar is controlled in another window. Stop following to move here.');return;}if(botEditor?.isOpen()&&!await botEditor.close())return;if(building){if(editor.isDirty()){toast('Save the room before walking to your desk');return;}toggleBuild(false,{record:false});}personalAreas?.close();const roomId=state.room.id;stopPlayer();try{const result=await api('/api/desk?roomId='+encodeURIComponent(roomId));if(state.room?.id!==roomId)return;if(!result.target){showDialog({eyebrow:'PERSONAL SPACE',title:'No desk assigned here',text:'Claim an eligible personal space in this room, or ask its owner to assign one.'});return;}if(!canStand(state.scene,result.target.x,result.target.z)){showDialog({title:'Your desk center is blocked',text:'Clear a standing spot in the center of your personal area, then try again.'});return;}const destination={x:result.target.x,z:result.target.z};path=findPath(state.scene,state.position,destination);if(!path.length&&Math.hypot(destination.x-state.position.x,destination.z-state.position.z)>.3){showDialog({title:'Your desk is not reachable',text:'Clear a path and try again.'});return;}pathSpeed=FAST_WALK_MULTIPLIER;deskTargetId=result.target.areaId;$('game').focus();renderer?.setDestination(destination);renderer?.setFollow(true);}catch(error){showDialog({title:'Could not reach your desk',text:error.message});}}
function quickActions(){const ready=()=>state.ready;return [
{id:'explore',label:'Explore places',description:'Universes, worlds and rooms',shortcut:'G',run:()=>places?.open('explore')},
{id:'chat',label:'Open room chat',shortcut:'C',enabled:ready,run:()=>togglePanel('chat')},
{id:'people',label:'People here',shortcut:'U',enabled:ready,run:()=>togglePanel('people')},
{id:'follow-people',label:groupState?.canStop?'Stop following or leading':'Invite nearby people to follow',shortcut:groupState?.invitations?.length&&!groupState.context?.following&&!groupState.leading&&!groupState.stopUnconfirmed?'':'F',enabled:()=>!!groupState?.canStop||!!groupState?.canAct&&!!groupState.context?.canInvite,run:()=>groupControls?.followAction()},
{id:'lock-conversation',label:groupState?.context?.locked?'Unlock nearby conversation':'Lock nearby conversation',enabled:()=>!!groupState?.canAct&&!!groupState.context?.canLock,run:()=>groupControls?.lock(!groupState.context?.locked)},
{id:'personal-areas',label:'Personal spaces in this room',shortcut:'L',enabled:ready,run:()=>openPersonalAreas()},
{id:'bots',label:'Build room residents',shortcut:'N',enabled:()=>state.ready&&state.botPermissions.canManage,run:()=>openBots()},{id:'desk',label:'Walk to my personal desk',shortcut:'Cmd/Ctrl D',enabled:ready,run:()=>walkToDesk()},
{id:'custom-images',label:'Custom images',description:'Browse and upload room PNG objects',keywords:'library PNG image upload decal panel',enabled:()=>state.ready,run:()=>openImageLibrary()},
{id:'build',label:'Build this place',shortcut:'E',enabled:()=>state.ready&&!!renderer&&canBuildInRoom(state.room),run:()=>toggleBuild(true)},
{id:'say',label:'Say something',shortcut:'Enter',enabled:ready,run:()=>express?.open('say')},
{id:'think',label:'Think out loud',shortcut:'Ctrl Enter',enabled:ready,run:()=>express?.open('think')},
{id:'profile',label:'Your character and profile',shortcut:'P',run:()=>togglePanel('settings')},{id:'avatar',label:'Create your 3D character',description:'Body, hair, clothes and accessories',run:()=>avatarCreator?.open()},
{id:'quests',label:'Your quest log',shortcut:'J',enabled:ready,run:()=>quests?.open()},
{id:'connect',label:'Voice, video and sharing',shortcut:'M',enabled:ready,run:()=>$('dock-media').click()},
{id:'manage',label:'Manage this place',enabled:ready,run:()=>places?.open('manage')},
{id:'share',label:'Share room link',description:'Choose a default or named arrival',enabled:()=>state.ready&&!navigating,run:()=>arrivalShare?.open()},
{id:'content-maximize',label:'Expand room content',description:'Cover the game and Chat without reloading content',enabled:()=>!!areaActions?.windowState().open&&!!areaActions?.windowState().canMaximize&&!areaActions?.windowState().maximized,run:()=>areaActions?.setWindowMaximized(true)},
{id:'content-restore',label:'Restore room content',description:'Return to your content window and the game',enabled:()=>contentMaximized(),run:()=>areaActions?.setWindowMaximized(false)},
{id:'reset-camera',label:'Reset camera',shortcut:'Home',enabled:()=>!!renderer,run:()=>renderer?.resetCamera()},
{id:'follow-camera',label:'Follow your character',shortcut:'Shift F',enabled:()=>!!renderer,run:()=>renderer?.setFollow(true)},
{id:'build-save',label:'Save this room',shortcut:'Cmd/Ctrl S',enabled:()=>building&&editor?.isDirty()&&!editor.isSaving(),run:()=>editor.save()},
{id:'build-undo',label:'Undo building change',shortcut:'Cmd/Ctrl Z',enabled:()=>building&&editor?.getInteractionState().undo>0,run:()=>editor.undo()},
{id:'build-redo',label:'Redo building change',shortcut:'Cmd/Ctrl Shift Z',enabled:()=>building&&editor?.getInteractionState().redo>0,run:()=>editor.redo()},
{id:'build-rotate',label:'Rotate selected item or preview',shortcut:'R',enabled:()=>building,run:()=>editor.rotate()},
{id:'build-duplicate',label:'Duplicate selected item',shortcut:'D',enabled:()=>building&&!!editor?.getSelected(),run:()=>editor.duplicate()},
{id:'build-erase',label:'Erase items',shortcut:'X',enabled:()=>building,run:()=>editor.setTool('erase')},
{id:'shortcuts',label:'Keyboard shortcuts',shortcut:'?',run:showShortcuts}];}
function applySourceIcons(){const docks={explore:'Planet',chat:'MessageCircle',people:'Users',media:'MicOn',emote:'Emoji',build:'Tools',settings:'Settings'};for(const[id,name]of Object.entries(docks)){$('dock-'+id).querySelector('span').innerHTML=icon(name);}const buttons={'zoom-in':'Plus','zoom-out':'Minus','rotate-camera':'RotateLeft','camera-right':'RotateRight','camera-tilt-up':'ChevronUp','camera-tilt-down':'ChevronDown','camera-pan':'Move','camera-follow':'Focus','home-camera':'Home','dialog-close':'Close','shortcuts-help':'Help'};for(const[id,name]of Object.entries(buttons))$(id).innerHTML=icon(name);$('shortcuts-help').setAttribute('aria-label','Keyboard shortcuts');$('quick-actions').innerHTML=icon('Command')+'<span>K</span>';$('quick-actions').setAttribute('aria-label','Quick actions');$('quest-open').textContent='Quests';$('quest-open').insertAdjacentHTML('afterbegin',icon('Star'));$('invite').textContent='Share link';$('invite').insertAdjacentHTML('afterbegin',icon('Share'));}
function setupControls(){applySourceIcons();
 for(const selector of ['.builder-toolbelt','.hud-right','#view-controls'])document.querySelector(selector)?.setAttribute('aria-description','Scroll or swipe horizontally for more controls. Tab brings each control into view.');
for(const b of document.querySelectorAll('#dock [data-panel]'))b.onclick=()=>togglePanel(b.dataset.panel);$('dock-build').onclick=()=>toggleBuild();$('dock-media').onclick=()=>{$('media').hidden=!$('media').hidden;$('dock-media').classList.toggle('active',!$('media').hidden);};$('dock-emote').onclick=()=>express?.toggle();for(const b of document.querySelectorAll('[data-emote]'))b.onclick=()=>{emote=b.dataset.emote;emoteUntil=Date.now()+4500;$('emotes').hidden=true;api('/api/rooms/'+state.room.id+'/emote',{method:'POST',body:{emoji:emote}}).catch(e=>toast(e.message));sendPresence(true);};
 const dockMore=document.createElement('span');dockMore.id='dock-more';dockMore.setAttribute('aria-hidden','true');dockMore.innerHTML=icon('ChevronRight');$('app').append(dockMore);$('dock').setAttribute('aria-description','Scroll or swipe horizontally for more controls. Tab brings each control into view.');const updateDockHint=()=>{dockMore.hidden=$('dock').scrollWidth-$('dock').clientWidth-$('dock').scrollLeft<2;};$('dock').addEventListener('scroll',updateDockHint);window.addEventListener('resize',updateDockHint);new ResizeObserver(updateDockHint).observe($('dock'));requestAnimationFrame(updateDockHint);
 $('quick-actions').onclick=()=>palette?.toggle();$('shortcuts-help').onclick=showShortcuts;$('manage-place').onclick=()=>places?.open('manage');$('places-alert').onclick=()=>{$('places-alert').hidden=true;places?.open('invitations');};$('quest-open').onclick=()=>quests?.open();$('zoom-in').onclick=()=>renderer?.zoom(-2);$('zoom-out').onclick=()=>renderer?.zoom(2);$('rotate-camera').onclick=()=>renderer?.orbit(-90,0);$('home-camera').onclick=()=>renderer?.resetCamera();$('camera-right').onclick=()=>renderer?.orbit(90,0);$('camera-tilt-up').onclick=()=>renderer?.orbit(0,-60);$('camera-tilt-down').onclick=()=>renderer?.orbit(0,60);$('camera-follow').onclick=()=>renderer?.setFollow(!renderer.getCameraState().follow);$('camera-pan').onclick=()=>{worldInput?.setPanMode(!worldInput.getPanMode());$('camera-pan').setAttribute('aria-pressed',String(worldInput.getPanMode()));};$('interact').onclick=()=>interact();$('dialog-close').onclick=()=>closeDialog();$('dialog').onclick=e=>{if(e.target===$('dialog'))closeDialog();};$('invite').onclick=()=>{if(!state.room){places?.open('explore');return;}if(!navigating)void arrivalShare?.open();};
 window.addEventListener('session-ended',()=>{imageLibrary?.suspend();editor.revert();location.reload();});window.addEventListener('social-close',()=>{clearActive();lastSurfaceClosed=performance.now();const surface=history.state?.surface;if(['chat','people','explore','settings'].includes(surface))dismissSurface(surface);($('dock-'+$('social').dataset.tab)||$('dock-chat')).focus({preventScroll:true});});window.addEventListener('profile-updated',()=>{renderPeople();sendPresence(true);});window.addEventListener('avatar-emote',e=>{emote=e.detail.emoji;emoteUntil=Date.now()+4500;renderPeople();sendPresence(true);});document.addEventListener('focusin',()=>{if(isTyping())stopPlayer();});window.addEventListener('editor-status',e=>{$('dirty-dot').hidden=!e.detail.dirty;});
 window.addEventListener('editor-review',e=>{stopPlayer();if(e.detail?.record===false){syncContentWindows();return;}if(e.detail?.open)rememberSurface('editor-review',{nested:true});else{lastSurfaceClosed=performance.now();if(!navigating)dismissSurface('editor-review');}});
 const interactive=target=>!!target?.closest?.('button,a,input,textarea,select,[role="button"],[contenteditable="true"]');
 let enterStartedInUi=false;
 const keyName=e=>e.key.length===1?e.key.toLowerCase():e.key;
 // Explicit camera mode wins over the editor's earlier bubbling arrow handler.
 window.addEventListener('keydown',e=>{
  if(e.isComposing||e.keyCode===229)return;
  // Native activation may close a control and move focus before Enter is released.
  // Keep that gesture with its UI origin, even after a long hold or lost focus.
  if(e.key==='Enter'&&!e.repeat)enterStartedInUi=interactive(e.target)||!!areaActions?.hasFocus()||!!express?.isOpen();
  if(imageLibrary?.hasFocus(e.target))return;
  // Onboarding and capability fallback are also true keyboard-modal surfaces.
  const entrySurface=!$('fallback').hidden?$('fallback'):!$('welcome').hidden&&!avatarCreator?.isOpen()?$('welcome'):null;
  if(entrySurface&&e.key==='Tab'){
   const nodes=[...entrySurface.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]')].filter(node=>node.getClientRects().length);
   if(nodes.length&&(!nodes.includes(document.activeElement)||(e.shiftKey&&document.activeElement===nodes[0])||(!e.shiftKey&&document.activeElement===nodes.at(-1)))){e.preventDefault();(e.shiftKey?nodes.at(-1):nodes[0]).focus();}
   e.stopImmediatePropagation();return;
  }
  // A foreground Express tray owns Escape even when focus moved to content underneath.
  if(e.key==='Escape'&&history.state?.surface==='express'&&express?.isOpen()&&!palette?.isOpen()&&!avatarCreator?.isOpen()&&$('dialog').hidden){if(express.handleKey(e))e.stopImmediatePropagation();return;}
  if(!$('dialog').hidden&&!palette?.isOpen()&&!avatarCreator?.isOpen()){
   if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();closeDialog();return;}
   if(e.key==='Tab'){
    const controls=[...$('dialog').querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(node=>node.getClientRects().length);
    const first=controls[0],last=controls.at(-1);
    if(first&&(!controls.includes(document.activeElement)||(e.shiftKey&&document.activeElement===first)||(!e.shiftKey&&document.activeElement===last))){e.preventDefault();(e.shiftKey?last:first).focus();}
    e.stopImmediatePropagation();return;
   }
  }
  if(contentMaximized()&&!contentHasHigherSurface()){
   if(e.key==='Escape'&&areaActions.handleWindowEscape(e)){e.stopImmediatePropagation();return;}
   if(e.key==='Tab'){
    const root=$('embedded-content'),controls=[...root.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),iframe,[tabindex="0"]')].filter(node=>node.getClientRects().length&&!node.hasAttribute('data-focus-guard')&&!node.closest('[hidden],[inert]'));
    const first=controls[0],last=controls.at(-1);
    if(first&&(!controls.includes(document.activeElement)||(e.shiftKey&&document.activeElement===first)||(!e.shiftKey&&document.activeElement===last))){e.preventDefault();(e.shiftKey?last:first).focus();}
    e.stopImmediatePropagation();return;
   }
  }
  if(worldInput?.getPanMode()&&!modalOpen()&&!isTyping()&&e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();worldInput.setPanMode(false);$('camera-pan').setAttribute('aria-pressed','false');stopPlayer();return;}
  if(worldInput?.getPanMode()&&!modalOpen()&&!isTyping()&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&e.key.startsWith('Arrow')){
   e.preventDefault();e.stopImmediatePropagation();stopPlayer();renderer?.pan(e.key==='ArrowLeft'?30:e.key==='ArrowRight'?-30:0,e.key==='ArrowUp'?30:e.key==='ArrowDown'?-30:0);return;
  }
 },true);
 window.addEventListener('keydown',e=>{if(imageLibrary?.hasFocus(e.target))return;if(state.user&&palette?.handleKey(e))e.stopImmediatePropagation();},true);
 window.addEventListener('keydown',e=>{
  if(e.isComposing||e.keyCode===229)return;
  if(state.user&&palette?.handleKey(e))return;
  if(!interactive(e.target)||express?.isOpen())if(express?.handleKey(e))return;
  if(e.defaultPrevented||isTyping()||avatarCreator?.isOpen()||!$('welcome').hidden||personalAreas?.isOpen()||quests?.isOpen()||places?.isOpen()||palette?.isOpen()||express?.isOpen())return;
  const k=keyName(e);
  if(imageLibrary?.isOpen()){if(k==='Escape'){e.preventDefault();imageLibrary.setOpen(false);}return;}
  if(e.ctrlKey||e.metaKey){if(k==='d'){e.preventDefault();if(!e.repeat)walkToDesk();}if(k==='s'&&botEditor?.isOpen()){e.preventDefault();botEditor.save();}return;}
  if(e.altKey)return;
  if(k==='Escape'&&botEditor?.isOpen()){e.preventDefault();if(!botMapInput?.cancelGesture())botEditor.close();return;}
  if(k==='Escape'){stopPlayer();if(worldInput?.getPanMode()){worldInput.setPanMode(false);$('camera-pan').setAttribute('aria-pressed','false');return;}if(!$('dialog').hidden){closeDialog();return;}if(!$('social').hidden){$('social').hidden=true;clearActive();dismissSurface(history.state?.surface);return;}if(!$('media').hidden){$('media').hidden=true;$('dock-media').classList.remove('active');return;}if(building){toggleBuild(false);return;}if(areaActions?.isOpen())areaActions.close();return;}
  if(k==='?'||k==='F1'){e.preventDefault();showShortcuts();return;}
  if(modalOpen())return;
  if(worldInput?.getPanMode()&&k.startsWith('Arrow')){e.preventDefault();renderer?.pan(k==='ArrowLeft'?30:k==='ArrowRight'?-30:0,k==='ArrowUp'?30:k==='ArrowDown'?-30:0);return;}
  if(botEditor?.isOpen()&&k.startsWith('Arrow')){e.preventDefault();botMapInput?.nudge(k);return;}
  if(botEditor?.isOpen()&&['w','a','s','d','z','q'].includes(k))return;
  if(['w','a','s','d','z','q','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(k)){if(!building){e.preventDefault();keys.add(k==='z'?'w':k==='q'?'a':k);}return;}
  if(k==='Shift'){keys.add(k);return;}
  if(k===' '&&!interactive(e.target)){e.preventDefault();return;}
  if(e.repeat)return;
  const actions={l:()=>openPersonalAreas(),n:()=>openBots(),c:()=>togglePanel('chat'),u:()=>togglePanel('people'),e:()=>toggleBuild(),b:()=>toggleBuild(),g:()=>togglePanel('explore'),j:()=>quests?.open(),p:()=>togglePanel('settings'),m:()=>$('dock-media').click(),f:()=>{if(e.shiftKey)$('camera-follow').click();else socialFollowShortcut();},Home:()=>renderer?.resetCamera(),'+':()=>renderer?.zoom(-2),'=':()=>renderer?.zoom(-2),'-':()=>renderer?.zoom(2),'[':()=>{if(!building)renderer?.orbit(-65,0);},']':()=>{if(!building)renderer?.orbit(65,0);},PageUp:()=>renderer?.orbit(0,-45),PageDown:()=>renderer?.orbit(0,45),r:()=>{if(!building){motion.heading=(motion.heading+Math.PI/2)%(Math.PI*2);state.direction=[0,2,3,1][((Math.round(motion.heading/(Math.PI/2))%4)+4)%4];sendPresence(true);}}};
  if(/^[1-6]$/.test(k)){e.preventDefault();express?.playSlot(Number(k)-1);return;}
  if(actions[k]){e.preventDefault();stopPlayer({cancelPath:true});actions[k]();}
 });
 window.addEventListener('keyup',e=>{const k=keyName(e);keys.delete(k==='z'?'w':k==='q'?'a':k);if(k==='Enter'&&enterStartedInUi){enterStartedInUi=false;return;}if(e.isComposing||e.keyCode===229||isTyping()||!$('welcome').hidden||places?.isOpen()||quests?.isOpen()||avatarCreator?.isOpen()||palette?.isOpen())return;if(performance.now()-lastSurfaceClosed<500)return;if(building&&k==='Enter'&&!e.ctrlKey&&!e.metaKey&&!e.altKey)return;if(!interactive(e.target)||express?.isOpen())if(express?.handleKey(e))return;if(e.defaultPrevented||modalOpen()||building||botEditor?.isOpen()||e.ctrlKey||e.metaKey||e.altKey)return;if(k===' '&&!interactive(e.target)){e.preventDefault();interact();}},true);
 window.addEventListener('blur',()=>{stopPlayer();followMotion.pause(motion,{path});});document.addEventListener('visibilitychange',()=>{stopPlayer();if(!document.hidden)sendPresence(true);});
 worldInput=mountWorldInput({canvas:$('game'),joystickRoot:$('joystick'),joystickThumb:$('joystick-thumb'),getContext:()=>({ready:state.ready,building:building||!!botEditor?.isOpen(),modalOpen:modalOpen()}),getRenderer:()=>renderer,getEditor:()=>botEditor?.isOpen()?botMapInput:editor,onJoystick:value=>joystick=value,onWalkTo:walkTo,onInteract:hit=>{if(hit.type==='bot'){const bot=state.bots.find(b=>b.id===hit.id);if(!bot)return false;if(state.botPermissions.canManage)openBots(bot.id);else showDialog({eyebrow:'ROOM BOT',title:bot.name,text:'This is a room resident. No AI provider is connected, so it stays silent.'});return true;}const o=state.scene.objects.find(o=>o.id===hit.id);if(!o||!(areaActions?.hasActions(o)||o.text))return false;if(Math.hypot(o.x-state.position.x,o.z-state.position.z)<2.7){interact(o);return true;}walkTo(nearestWalkable(state.scene,{x:o.x,z:o.z+1.6}));return true;}});
 window.addEventListener('popstate',()=>surfaceHistory.replay(()=>{
  let destination;try{destination=readTravelLocation(location.href);}catch(error){toast(error.message);return;}
  if(destination.roomId&&(!state.destination||destinationKey(destination)!==destinationKey(state.destination))){joinRoom(destination.roomId,{entry:destination.entry,historyMode:'replace'}).catch(()=>{});return;}const surface=history.state?.surface==='explore'?'places':history.state?.surface;
  if(history.state?.surface==='explore')history.replaceState({...history.state,surface:'places'},'',location.href);
  const layers=new Set(surfaceLayers(history.state,state.room?.id||null));
  const socialSurface=['chat','people','settings'].find(name=>layers.has(name));
  if(!socialSurface){$('social').hidden=true;clearActive();}else{social.setTab(socialSurface);clearActive();$('dock-'+socialSurface)?.classList.add('active');}
  if(layers.has('images')&&!imageLibrary?.isOpen())openImageLibrary({record:false});else if(!layers.has('images')&&imageLibrary?.isOpen())imageLibrary.setOpen(false,{record:false});
  if(layers.has('bots')&&!botEditor?.isOpen())openBots();else if(!layers.has('bots')&&botEditor?.isOpen())botEditor.close().then(ok=>{if(!ok)rememberSurface('bots');});
  if(layers.has('personal')&&!personalAreas?.isOpen())personalAreas?.restore();else if(!layers.has('personal')&&personalAreas?.isOpen())personalAreas.close();
  const content=history.state?.room===state.room?.id?history.state?.content:null;
  if(content&&areaActions?.historyKey()===content){if(!areaActions.isOpen())areaActions.restore(content,{focus:surface==='content',isCurrent:()=>surfaceHistory.wantsContent(content)}).then(ok=>{if(ok===false&&!areaActions.isOpen())surfaceHistory.forgetContent(content);});}else{areaActions?.close();
  if(content)surfaceHistory.forgetContent(content);}
  if(layers.has('avatar')&&!avatarCreator?.isOpen())avatarCreator?.open();else if(!layers.has('avatar')&&avatarCreator?.isOpen())avatarCreator.close();
  if(layers.has('palette')&&!palette?.isOpen())palette?.open();else if(!layers.has('palette')&&palette?.isOpen())palette.close();
  if(layers.has('express')&&!express?.isOpen())express?.open('say');else if(!layers.has('express')&&express?.isOpen())express.close();
  if(layers.has('places')&&!places?.isOpen())places?.open('explore');else if(!layers.has('places')&&places?.isOpen())places.close();
  if(layers.has('quests')&&!quests?.isOpen())quests?.open();else if(!layers.has('quests')&&quests?.isOpen())quests.close();
  if(!layers.has('dialog')){if(!$('dialog').hidden)closeDialog(false);}else{const wasHidden=$('dialog').hidden;$('dialog').hidden=false;
  if(wasHidden){stopPlayer();$('dialog-close').focus();}}
  if(!layers.has('editor-review')&&editor?.isReviewOpen?.())editor.closeReview({record:false});
  if(layers.has('build')&&!building)toggleBuild(true,{record:false});
  if(layers.has('editor-review')&&(!building||!editor?.openReview?.())){const next={...history.state};delete next.underlay;if(building)next.surface='build';else delete next.surface;history.replaceState(next,'',location.href);}
  if(!layers.has('build')&&!layers.has('images')&&building){building=false;$('editor').hidden=true;$('quest-open').hidden=false;$('dock-build').classList.remove('active');renderer?.setBuild(false);editor.setBuild(false);updateTitle();}
 }));
 window.addEventListener('beforeunload',e=>{if(editor.isDirty()){e.preventDefault();e.returnValue='';}});}
async function boot(){arrivalShare=createArrivalShare({root:$('dialog-content'),api,getState,openDialog:showDialog,isOpen:()=>!$('dialog').hidden&&$('dialog').dataset.actionOwner==='share-arrival',toast});const accessRequest=api('/api/access').catch(()=>({mode:'unknown',guestCreation:false,registration:false,login:true,provisioning:'unavailable'}));const contentRoot=document.createElement('div');contentRoot.id='embedded-content';$('app').append(contentRoot);areaActions=mountActionRuntime({root:contentRoot,controlsRoot:$('area-sounds'),api,getState,beforeResolve:async({deliberate})=>{if(deliberate)stopPlayer();if(!await sendPresence(true))throw Error('Your room position could not be confirmed. Try again when connected.');},onDialog:showDialog,onCloseDialog:owner=>{if($('dialog').dataset.actionOwner===owner&&!$('dialog').hidden)closeDialog();},onNavigate:(id,options)=>joinRoom(id,options),getGameWidth:()=>$('game').getBoundingClientRect().width,onWindowChange:window=>{if(window.open&&(window.maximized||window.resizing))stopPlayer();syncContentWindows();if(palette?.isOpen())palette.refresh();},onOpenChange:open=>{if(open){stopPlayer();rememberSurface('content',{nested:true});}else if(!navigating)dismissSurface('content');},toast});for(const[i,preset]of AVATAR_PRESETS.entries()){const b=document.createElement('button');b.type='button';b.className='avatar-preset'+(i===0?' selected':'');b.ariaLabel='Choose '+preset.name;b.ariaPressed=String(i===0);const placeholder=document.createElement('span');placeholder.textContent=preset.name.split(' ')[0];b.append(placeholder);createAvatarPortrait(preset.appearance).then(url=>{const img=document.createElement('img');img.src=url;img.alt='';b.replaceChildren(img);}).catch(()=>{});b.onclick=()=>{selectedWoka=i;selectedAppearance=normalizeAppearance(preset.appearance);for(const[n,node]of [...$('woka-options').children].entries()){node.classList.toggle('selected',n===i);node.ariaPressed=String(n===i);}};$('woka-options').append(b);}
 $('customize-character').onclick=()=>avatarCreator?.open({appearance:selectedAppearance,onCommit:appearance=>{selectedAppearance=normalizeAppearance(appearance);for(const node of $('woka-options').children){node.classList.remove('selected');node.ariaPressed='false';}$('customize-character').textContent='Character ready · Edit again';}});

 editor=mountEditor({root:$('editor'),getState,onScene:setScene,onSelect:id=>renderer?.select(id),onGhost:ghost=>renderer?.setGhost(ghost),getCameraAngle:()=>renderer?.getCameraAngle()??Math.PI/4,isBlocked:()=>modalOpen()||!!botEditor?.isOpen(),editPolicy:personalEditPolicy,onOpenImageLibrary:()=>openImageLibrary(),onTrySavedArrival:saved=>joinRoom(saved.roomId,{entry:saved.entry,savedArrival:saved}),onManagePersonalArea:id=>{if(editor.isDirty()){toast('Save this room before managing personal-space ownership');return;}personalAreas?.open(id);},api,toast,onClose:()=>toggleBuild(false)});social=mountSocial({root:$('social'),api,getState:()=>({...state,navigating}),onNearbyUnread:count=>{nearbyUnread=count;updateUnreadBadge();},onNavigate:id=>joinRoom(id).catch(()=>{}),onExplore:()=>places?.open('explore'),onManage:()=>places?.open('manage'),onAvatar:()=>avatarCreator?.open(),portrait:person=>createAvatarPortrait(appearanceForUser(person)),toast});media=mountMedia({root:$('media'),api,getState,toast});quests=mountQuests({root:$('quests'),api,getContext:()=>({user:state.user,room:state.room,ready:state.ready,busy:places?.isOpen()||building||!$('social').hidden||!$('media').hidden||!$('dialog').hidden}),onGuide:target=>renderer?.setGuide(target?.roomId===state.room?.id?target:null),onWalk:async target=>{if(target.roomId!==state.room?.id)await joinRoom(target.roomId);const landing=nearestWalkable(state.scene,{x:target.x,z:target.z});path=findPath(state.scene,state.position,landing);renderer?.setGuide(target);},onCancelWalk:()=>{path=[];},onOpenEditor:()=>toggleBuild(true),onRegister:()=>togglePanel('settings'),onOpenChange:open=>{keys.clear();path=[];joystick={x:0,z:0};if(open){rememberSurface('quests');if(building)toggleBuild(false,{record:false});$('social').hidden=true;clearActive();}else dismissSurface('quests');}});places=mountPlaces({root:$('places'),api,getState,onNavigate:id=>joinRoom(id),onChanged:()=>refreshCatalog(),toast,onOpenChange:open=>{keys.clear();path=[];joystick={x:0,z:0};if(open){rememberSurface('places');if(building)toggleBuild(false,{record:false});if(quests?.isOpen())quests.close();$('social').hidden=true;clearActive();$('dock-explore').classList.add('active');}else{dismissSurface('places');$('dock-explore').classList.remove('active');}}});avatarCreator=mountAvatarCreator({root:$('avatar-creator'),api,getState,onSaved:async user=>{state.user=user;for(const person of state.people)if(person.id===user.id)Object.assign(person,user);social.render();renderPeople();await sendPresence(true);},onOpenChange:open=>{stopPlayer();renderer?.setPresentationSuspended(open);if(open)rememberSurface('avatar',{nested:true});else{lastSurfaceClosed=performance.now();dismissSurface('avatar');}},toast});express=mountExpress({root:$('express'),api,getState,beforeSend:async({roomId})=>{stopMotion(motion);state.moving=false;if(!await sendPresence(true)||state.room?.id!==roomId)throw new Error('Your position could not be confirmed. Please try again.');},project:person=>renderer?.screenPoint(person.x,person.z,2.6),toast,canOpen:()=>state.ready&&!avatarCreator?.isOpen()&&!places?.isOpen()&&!quests?.isOpen()&&!palette?.isOpen()&&$('dialog').hidden,onReturnFocus:()=>{if(contentMaximized())$('embedded-content').querySelector('.embedded-maximize')?.focus();else $('game').focus();},onEmote:emoji=>{emote=emoji;emoteUntil=Date.now()+5000;sendPresence(true);},onOpenChange:open=>{stopPlayer();if(open){if(building)toggleBuild(false,{record:false});rememberSurface('express',{nested:true});}else{lastSurfaceClosed=performance.now();dismissSurface('express');}}});palette=mountPalette({root:$('command-palette'),getState,getActions:quickActions,portrait:person=>createAvatarPortrait(appearanceForUser(person)),onPerson:person=>{if(quests?.isOpen())quests.close();if(places?.isOpen())places.close();togglePanel('chat');social.openDm(person);},onNavigate:id=>joinRoom(id),onWalkToPerson:person=>walkTo(nearestWalkable(state.scene,{x:person.x,z:person.z+1.1})),canWalkToPerson:()=>state.ready&&!building&&!groupState?.followingReadOnly,onOpenChange:open=>{if(open&&personalAreas?.isOpen())personalAreas.close();stopPlayer();if(open)rememberSurface('palette',{nested:true});else{lastSurfaceClosed=performance.now();dismissSurface('palette');}},toast});const personalRoot=document.createElement('div');personalRoot.id='personal-areas';$('app').append(personalRoot);personalAreas=mountPersonalAreas({root:personalRoot,getState,api,onRoom:room=>{if(room.id!==state.room?.id)return;imageLibrary?.receiveRoom(room);editor.cancelGesture();editor.receiveScene(room);imageLibrary?.syncAuthority();updateTitle();},onBuild:()=>toggleBuild(true),onDesk:()=>walkToDesk(),onRegister:()=>togglePanel('settings'),beforeOperation:async()=>{if(editor.isSaving()||editor.isDirty())throw Error('Save or discard your room draft before changing ownership');stopPlayer();if(!await sendPresence(true))throw Error('Reconnect to this room before changing ownership');return true;},onOpenChange:open=>{stopPlayer();if(open)rememberSurface('personal',{nested:true});else{dismissSurface('personal');if(!document.activeElement?.getClientRects().length)$('game').focus();}},toast});
 botEditor=createBotEditor({getRoom:()=>state.room,getActorId:()=>state.user?.id||null,request:api,host:$('app'),onFocus:point=>renderer?.focusPoint(point.x,point.z),onPreview:preview=>{botMapInput?.cancelGesture();botPreviewState=preview?.bot?preview:null;renderer?.setBotPreview(botPreviewState?.bot||null);renderPeople();},onClose:()=>{botPreviewState=null;renderer?.setBotPreview(null);if(!navigating)dismissSurface('bots');renderPeople();},onSaved:()=>{toast('Resident saved');}});
 botMapInput=createBotMapInput({getEditor:()=>botEditor,getState,getPreview:()=>botPreviewState,getCameraAngle:()=>renderer?.getCameraAngle()??Math.PI/4,showPreview:bot=>renderer?.setBotPreview(bot),toast});
 const imageRoot=document.createElement('section');imageRoot.id='image-library';const imageStatus=document.createElement('section');imageStatus.id='image-render-status';imageStatus.hidden=true;imageStatus.setAttribute('role','status');imageStatus.setAttribute('aria-live','polite');imageStatus.setAttribute('aria-label','Custom image loading status');$('app').append(imageRoot,imageStatus);imageLibrary=mountImageLibraryShell({root:imageRoot,statusRoot:imageStatus,getState,getRenderer:()=>renderer,icon,onDefinitions:()=>{renderer?.sync(state.scene);},onChoose:ref=>{const returnToBuild=building;imageLibrary.setOpen(false,{record:returnToBuild});if(!building)toggleBuild(true,{record:false});if(!building||editor.setImageAsset(ref)===false){imageLibrary.setOpen(true);return false;}if(surfaceHistory.backPending)surfaceHistory.queue('build');else if(!returnToBuild)history.replaceState({room:state.room?.id,surface:'build'},'',location.href);$('game').focus();return true;},onOpenChange:open=>{stopPlayer();if(open)rememberSurface('images',{nested:true});else{lastSurfaceClosed=performance.now();if(!navigating)dismissSurface('images');if(!document.activeElement?.getClientRects().length)$('game').focus();}},onAuthorityLost:error=>{toast(error.status===401?'Your room session changed. Rejoin to use Custom images.':'Custom images are no longer readable in this room.');}});
 const groupRoot=document.createElement('section');groupRoot.id='proximity-controls';$('app').append(groupRoot);
 groupControls=createProximityControls({api,getState:()=>({...state,navigating}),onChange:syncGroupState});groupView=mountProximityControls({root:groupRoot,controller:groupControls,onReturnFocus:()=>$('game').focus({preventScroll:true})});syncGroupState();
 contentModality=createContentWindowModality({getWindow:()=>areaActions.windowState(),setForeground:value=>areaActions.setWindowForeground(value),hasHigherSurface:contentHasHigherSurface,getCoveredElements:()=>[
  ...['viewport','hud','dock','social','editor','media','area-sounds','area-banner','quest-open','view-controls','interaction','quick-actions','shortcuts-help','controls-hint','coords','joystick','emotes','image-render-status'].map($)
 ]});
 syncWindowControls=createWindowControlStates([
  ...['chat','people','settings'].map(tab=>({button:$('dock-'+tab),controls:'social',isOpen:()=>!$('social').hidden&&$('social').dataset.tab===tab})),
  {button:$('dock-explore'),controls:'places',isOpen:()=>!!places?.isOpen()},
  {button:$('dock-media'),controls:'media',isOpen:()=>!$('media').hidden},
  {button:$('dock-emote'),controls:'express',isOpen:()=>!!express?.isOpen()}
 ]);syncContentWindows();
 const botButton=document.createElement('button');botButton.id='manage-bots';botButton.className='small-btn';botButton.textContent='Bots';botButton.title='Build room residents · N';botButton.hidden=true;botButton.onclick=()=>openBots();document.querySelector('.hud-right').prepend(botButton);setupControls();
 try{renderer=await createRenderer($('game'),$('labels'));renderer.setPresentationSuspended(!!avatarCreator?.isOpen());imageLibrary?.syncRenderer();renderer.sync(state.scene);renderer.syncPeople([{id:'welcome',name:'Your story starts here',woka:0,x:0,z:7,self:true}]);await renderer.ready;}catch(e){console.error('3D renderer unavailable',e);$('joystick').hidden=true;$('view-controls').hidden=true;$('controls-hint').hidden=true;$('fallback-message').textContent='The 3D view could not start in this browser. You can still use room chat, people, and navigation. Try a WebGL-capable browser for movement and building.';$('fallback-enter').onclick=()=>{$('fallback').hidden=true;togglePanel('chat');};}
 requestAnimationFrame(loop);$('show-login').onclick=()=>{const login=$('login-form').hidden;$('login-form').hidden=!login;$('join-form').hidden=login;$('show-login').textContent=login?'Start with a new guest profile':'Already have a local account?';if(login)$('login-username').focus();};$('login-form').onsubmit=async e=>{e.preventDefault();$('login-button').disabled=true;$('login-error').textContent='';try{const session=await api('/api/login',{method:'POST',body:{username:$('login-username').value.trim(),password:$('login-password').value}});$('login-password').value='';await loadSession(session);}catch(error){$('login-error').textContent=error.message;}finally{$('login-button').disabled=false;}};$('join-form').onsubmit=async e=>{e.preventDefault();$('join-button').disabled=true;$('join-error').textContent='';try{await loadSession(await api('/api/session',{method:'POST',body:{name:$('display-name').value.trim(),appearance:selectedAppearance}}));if(!renderer)$('fallback').hidden=false;}catch(e){$('join-error').textContent=e.message;}finally{$('join-button').disabled=false;}};
 state.accessPolicy=await accessRequest;if(!state.accessPolicy.guestCreation){$('join-form').hidden=true;$('login-form').hidden=false;$('show-login').hidden=true;document.querySelector('.session-note').textContent='This private preview uses accounts provisioned by its operator. Sign in with your assigned account.';}bootReady=true;$('join-button').disabled=!state.accessPolicy.guestCreation;$('login-button').disabled=false;try{const session=await api('/api/session');await loadSession(session);if(!renderer)$('fallback').hidden=false;}catch(e){if(e.status!==401)$('join-error').textContent='The server is not ready. Please retry in a moment.';if(!$('welcome').hidden&&!avatarCreator?.isOpen())$(state.accessPolicy.guestCreation?'display-name':'login-username').focus();}
 window.__universe={getState:()=>clone({...state,scene:state.scene}),getStats:()=>renderer?.getStats(),getCreatorPreview:()=>avatarCreator?.getPreviewState(),getCamera:()=>renderer?.getCameraState(),getMotion:()=>({speed:Math.hypot(motion.velocity.x,motion.velocity.z),heading:motion.heading,running:motion.running}),getScreenPoint:(x,z,y=0)=>renderer?.screenPoint(x,z,y),getEditor:()=>editor.getInteractionState(),getPath:()=>clone(path),getProximityControls:()=>groupControls?.snapshot(),getFollowMotion:()=>followMotion.snapshot()};
}
boot().catch(e=>{console.error(e);toast('Could not open Universe: '+e.message);});
