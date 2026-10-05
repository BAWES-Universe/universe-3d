import {bindCompositionDefinitions,compositionDefinitions,resolvedComposition} from './composition-context.js';
import {validateCompositionObject} from './composition-geometry.js';
import {SCENE_OPERATION_FIELDS} from './scene-operations.js';
import {icon} from './universe-icons.js';
import {ENTRY_KEY_RE,validateStarts} from './arrivals.js';
import {createDestinationEntryLoader,destinationRoomsFromWorlds,mountDestinationPicker} from './destination-picker.js';
import {roomAllows} from './permissions.js';
import {attachRoomFile,listRoomFiles,FILE_ACCEPT} from './files.js';
import {CATALOG,clone,canStand,contains} from './worlds.js';
import {snapPoint,validatePlacement,screenGridStep,validateTerrainEdit,wallFromStroke} from './editor-geometry.js';
import {TERRAIN_MATERIALS,MAX_TERRAIN_CELLS,terrainCell,terrainRect,validateTerrain} from './terrain.js';
import {imageDefinitions,resolvedImage,bindImageDefinitions,mergeImageDefinitions} from './image-asset-context.js';
import {validateAssetReference,validateImageInstance,imagePhysicalSize,imageLibraryMetadata} from './image-asset-schema.js';
import {ACTION_TYPES,MAX_ACTIONS,createAction,itemActions,materializeItemActions,actionName,validateActions,safeActionUrl} from './action-schema.js';
import {jsonSnapshot,sceneChanges,reconcileScenes,rebaseHistory,createSceneOperationRequest,conflictLabel,conflictValueLabel,sceneRequestHash,reconciliationGeometryProblem,reconnectDraftReference} from './editor-collaboration.js';
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const uid=()=>crypto.randomUUID();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const touchUI=()=>window.matchMedia?.('(pointer:coarse)').matches;
const control=target=>!!target?.closest?.('button,a,summary,[role="button"],[role="menu"],[role="menuitem"]');
const typing=target=>!!target?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]');

export function mountEditor({root,getState,onScene,onSelect,api,toast,onClose,onGhost=()=>{},onModeChange=()=>{},getCameraAngle=()=>Math.PI/4,isBlocked=()=>false,editPolicy=()=>null,onManagePersonalArea=()=>{},onOpenImageLibrary=()=>{},onOpenWorkshop=()=>{},getDestinationRooms=()=>destinationRoomsFromWorlds(getState().worlds,getState().universes),onTrySavedArrival=null}){
 const historyFeedbackCache=new WeakMap();
 const loadDestinationEntries=createDestinationEntryLoader({api});let destinationPickers=[],tryingArrival=false;
 let tool='select',selected=null,history=[],future=[],dirty=false,saving=false,base=null,roomId=null,actorId,admission=null,conflictRoom=null,pendingSave=null;
 let enabled=false,gesture=null,preview=null,lastHit=null,rotation=0,snap=1,imageSnap=false,imageAsset=null,compositionAsset=null,compositionName='Furniture',copyTemplate=null,roomSettings=false,trayOpen=true;
 let compact=false,shortLayout=false,moreOpen=false;
 let retrySave=null,review=null,reviewOpen=false,reviewChoices={},forceLegacy=false,historyNotice='';
 let terrainOpen=false,terrainMaterial='stone',terrainBlocked=false,terrainSize={width:1,depth:1},terrainValidation=null;
 const terrainTool=()=>tool==='terrain'||tool==='terrain-erase';
 const strokeTool=()=>terrainTool()||tool==='wall-draw';
 let inspectorKey='',lastMessage='',saveError='',saveEpoch=0,roomEpoch=0,flushing=false,pointerControl=null,deferredInspector=false,validationCache=null;
 root.classList.add('editor-workbench');
 const getScene=()=>getState().scene;
 const roomPermission=()=>roomAllows(getState().room,'canEditScene');
 const policy=()=>editPolicy(getState())||{};
 const permission=()=>roomPermission()||policy().canEdit===true;
 const itemPermission=item=>roomPermission()||!!item&&policy().canEditItem?.(item)===true;
 const changeError=(before,next,imageBase=base)=>{for(const item of next.objects||[]){if(item.type!=='image'||resolvedImage(getScene(),item)?.status!=='archived')continue;const previous=imageBase?.objects.find(old=>old.id===item.id&&old.type==='image');if(!previous||previous.assetRef.assetId!==item.assetRef.assetId||previous.assetRef.versionId!==item.assetRef.versionId)return 'Restore this archived image in Custom before adding a new placement or undoing a saved removal.';}if(roomPermission())return null;if(!same(before?.areas,next?.areas))return 'Only room owners and editors can change areas or arrivals';if(!same(before?.terrain,next?.terrain))return 'Only room owners and editors can change terrain';const scoped=policy();return scoped.canEdit===true&&typeof scoped.validateChange==='function'?scoped.validateChange(before,next):'Only room owners and editors can change room settings';};
 const itemById=id=>[...(getScene()?.objects||[]),...(getScene()?.areas||[])].find(i=>i.id===id);
 const active=()=>enabled&&!root.hidden&&!!getScene()&&!isBlocked()&&!reviewOpen;
 const operationVersion=()=>{const room=getState().room,v2=room?.sceneOperationsV2;return v2?.version===2&&Array.isArray(v2.sceneFields)&&v2.sceneFields.length===SCENE_OPERATION_FIELDS.length&&SCENE_OPERATION_FIELDS.every(field=>v2.sceneFields.includes(field))?2:room?.sceneOperations?.version===1?1:0;};
 const collaborative=()=>operationVersion()>0;
 function button(label,action,title=label){const b=el('button','small-btn',label);b.type='button';b.title=title;b.onclick=event=>{pointerControl=null;flushFields();action(event);if(deferredInspector){deferredInspector=false;update();}};return b;}
 const header=el('div','builder-heading');const title=el('div','builder-title');title.append(el('span','builder-eyebrow','MAKE THIS PLACE YOURS'),el('strong','','Build mode'));
 const close=button('Done',()=>{cancelGesture();onClose?.();},'Leave build mode');close.ariaLabel='Close editor';close.classList.add('builder-done');header.append(title,close);
 const status=el('div','editor-status','All changes saved');status.setAttribute('aria-live','polite');header.append(status);root.append(header);
 const belt=el('div','builder-toolbelt');belt.setAttribute('role','toolbar');belt.setAttribute('aria-label','Build tools');root.append(belt);
 const selectBtn=button('↖ Select',()=>setTool('select'),'Select and drag an item (V)');
 const eraseBtn=button('⌫ Erase',()=>setTool('erase'),'Click an item to erase it (X)');
 const addBtn=button('＋ Furniture',()=>{cancelGesture();terrainOpen=false;roomSettings=false;selected=null;onSelect(null);moreOpen=false;trayOpen=!trayOpen;update({inspect:false});},'Open the furniture tray');
 const terrainBtn=button('Terrain',()=>{if(terrainOpen){terrainOpen=false;update({inspect:false});}else setTool('terrain');},'Paint floors and water, or draw walls');terrainBtn.ariaLabel='Terrain';
 const customBtn=button('Custom images',()=>{cancelGesture();moreOpen=false;update({inspect:false});onOpenImageLibrary();},'Open the room’s custom image library');customBtn.classList.add('builder-custom-images');
 const workshopBtn=button('Workshop',()=>{cancelGesture();moreOpen=false;update({inspect:false});onOpenWorkshop();},'Make and place your own multipart furniture');workshopBtn.ariaLabel='Furniture workshop';
 const areaBtn=button('▱ Area',()=>setTool('area'),'Place an interactive area');
 const rotateBtn=button('↻ Rotate',()=>rotate(),'Rotate 90° (R)');
 const duplicateBtn=button('⧉',()=>duplicate(),'Duplicate selected item (D)');duplicateBtn.ariaLabel='Duplicate selected item';
 const undo=button('↶',()=>undoScene(),'Undo last change (Ctrl/Cmd+Z)');undo.ariaLabel='Undo';
 const redo=button('↷',()=>redoScene(),'Redo (Ctrl/Cmd+Shift+Z)');redo.ariaLabel='Redo';
 for(const [control,name,label] of [[duplicateBtn,'Copy','Duplicate'],[undo,'Undo','Undo'],[redo,'Redo','Redo']]){control.innerHTML=icon(name);control.append(el('span','builder-extra-label',label));}
 const snapBtn=button('Grid 1m',()=>{if(floatingImage(activeImage())){if(!imageSnap){imageSnap=true;snap=1;}else if(snap===1)snap=.5;else imageSnap=false;}else snap=snap===1?.5:1;cancelGesture();refreshPreview();update({inspect:false});mode();},'Toggle 1 metre / half-metre snapping');
 const settingsBtn=button('⚙ Room',()=>{cancelGesture();roomSettings=!roomSettings;selected=null;onSelect(null);trayOpen=false;terrainOpen=false;moreOpen=false;update({inspect:true});},'Room settings, areas and room files');settingsBtn.classList.add('builder-room-settings');header.insertBefore(settingsBtn,close);
 const save=button('Save room',()=>saveScene(),'Save room (Ctrl/Cmd+S)');save.classList.add('primary','builder-save');save.ariaLabel='Save room';
 const fullTools=[selectBtn,eraseBtn,addBtn,terrainBtn,workshopBtn,customBtn,areaBtn,rotateBtn,duplicateBtn,undo,redo,snapBtn,save];
 const extraTools=[undo,redo,eraseBtn,workshopBtn,customBtn,areaBtn,duplicateBtn,snapBtn];
 const moreBtn=button('More',()=>{moreOpen=!moreOpen;trayOpen=false;terrainOpen=false;roomSettings=false;update({inspect:false});},'More build tools');moreBtn.ariaLabel='More build tools';moreBtn.classList.add('builder-more');
 const moreTray=el('section','builder-tools');moreTray.ariaLabel='More build tools';moreTray.hidden=true;const moreTop=el('div','builder-tray-top');moreTop.append(el('strong','','More build tools'));const moreClose=button('×',()=>{moreOpen=false;update({inspect:false});moreBtn.focus();},'Close more build tools');moreClose.ariaLabel='Close more build tools';moreTop.append(moreClose);const moreBody=el('div','builder-sheet-body builder-extra-tools');moreTray.append(moreTop,moreBody);root.append(moreTray);
 belt.append(...fullTools);rotateBtn.classList.add('builder-rotate');
 const tray=el('section','builder-tray');tray.ariaLabel='Furniture tray';const trayTop=el('div','builder-tray-top');trayTop.append(el('strong','','A few things to make it yours'));
 const trayClose=button('×',()=>{trayOpen=false;update({inspect:false});focusCanvas();},'Close furniture tray');trayClose.ariaLabel='Close furniture tray';trayTop.append(trayClose);tray.append(trayTop);
 const search=el('input','builder-search');search.type='search';search.placeholder='Find furniture or a placed item…';search.ariaLabel='Search room items';const trayBody=el('div','builder-sheet-body');tray.append(trayBody);trayBody.append(search);
 const results=el('div','editor-search-results');trayBody.append(results);const catalog=el('div','catalog');trayBody.append(catalog);root.append(tray);
 const shortNames={table:'Table',chair:'Chair',sofa:'Sofa',plant:'Plant',tree:'Tree',wall:'Wall',lamp:'Lantern',screen:'Screen',podium:'Podium',portal:'Portal',rug:'Rug',board:'Board',bench:'Bench',rock:'Stone'};
 for(const [type,def]of Object.entries(CATALOG)){
  const b=button('',()=>setTool(type),def.name+' · '+def.width+' × '+def.depth+' m');b.dataset.tool=type;b.ariaLabel='Place '+def.name;
  const art=el('span','furniture-icon furniture-'+type,def.icon);art.style.setProperty('--item-color',def.color);art.setAttribute('aria-hidden','true');b.append(art,el('span','furniture-name',shortNames[type]||def.name));catalog.append(b);
 }
 search.oninput=renderSearch;
 const terrainTray=el('section','builder-terrain');terrainTray.ariaLabel='Terrain tools';terrainTray.hidden=true;
 const terrainTop=el('div','builder-tray-top');terrainTop.append(el('strong','','Make a path, a pond, a place'));
 const terrainClose=button('×',()=>{terrainOpen=false;update({inspect:false});focusCanvas();},'Close terrain palette');terrainClose.ariaLabel='Close terrain palette';terrainTop.append(terrainClose);terrainTray.append(terrainTop);const terrainBody=el('div','builder-sheet-body');terrainTray.append(terrainBody);
 const materials=el('div','terrain-materials');materials.setAttribute('role','group');materials.ariaLabel='Ground material';
 const materialNames={grass:'Grass',soil:'Soil',stone:'Stone',wood:'Wood',water:'Water'};
 for(const material of TERRAIN_MATERIALS){const b=button(materialNames[material],()=>{terrainMaterial=material;terrainBlocked=material==='water';setTool('terrain');},'Paint '+materialNames[material].toLowerCase());b.dataset.material=material;b.ariaLabel='Paint '+materialNames[material].toLowerCase();b.prepend(el('span','terrain-swatch'));materials.append(b);}terrainBody.append(materials);
 const terrainActions=el('div','terrain-actions');
 const wallDrawBtn=button('Draw wall',()=>setTool('wall-draw'),'Drag a straight wall, then use Select to move or rotate it');wallDrawBtn.dataset.tool='wall-draw';
 const terrainEraseBtn=button('Restore base',()=>setTool('terrain-erase'),'Erase authored terrain to reveal the original ground');terrainEraseBtn.dataset.tool='terrain-erase';
 const blockedLabel=el('label','terrain-blocking');const blockedInput=el('input');blockedInput.type='checkbox';blockedInput.ariaLabel='Blocks walking';blockedInput.onchange=()=>{cancelGesture();terrainBlocked=blockedInput.checked;refreshPreview();update({inspect:false});};blockedLabel.append(blockedInput,el('span','','Blocks walking'));
 terrainActions.append(wallDrawBtn,terrainEraseBtn,blockedLabel);terrainBody.append(terrainActions);
 const terrainNote=el('p','terrain-note');terrainBody.append(terrainNote);root.append(terrainTray);

 const inspectorShell=el('section','builder-inspector');const inspectorHeader=el('div','builder-inspector-heading');const inspectorTitle=el('strong','','Item details');const inspectorClose=button('×',()=>{roomSettings=false;if(selected){selected=null;onSelect(null);}cancelGesture();update();focusCanvas();},'Close item details');inspectorClose.ariaLabel='Close item details';inspectorHeader.append(inspectorTitle,inspectorClose);inspectorShell.append(inspectorHeader);
 const inspector=el('div','inspector');inspectorShell.append(inspector);root.append(inspectorShell);
 const inspectorPointerDown=event=>{const target=event.target?.closest?.('button');pointerControl=target&&inspector.contains(target)?target:null;};
 const inspectorPointerEnd=()=>{const target=pointerControl;if(!target)return;setTimeout(()=>{if(pointerControl!==target)return;pointerControl=null;if(deferredInspector){deferredInspector=false;update();}},0);};
 root.addEventListener('pointerdown',inspectorPointerDown,true);window.addEventListener('pointerup',inspectorPointerEnd);window.addEventListener('pointercancel',inspectorPointerEnd);
 // Selecting on touch-down can open a sheet beneath the finger. The browser's
 // later click must not activate that new sheet's Close/Delete/etc. controls.
 let touchStartedInEditor=true;
 const rememberTouchOrigin=event=>{if(event.pointerType==='touch')touchStartedInEditor=root.contains(event.target);};
 const guardTouchClick=event=>{if(event.pointerType==='touch'&&event.detail>0&&!touchStartedInEditor){event.preventDefault();event.stopImmediatePropagation();}};
 window.addEventListener('pointerdown',rememberTouchOrigin,true);root.addEventListener('click',guardTouchClick,true);
 const hint=el('div','builder-hint');hint.setAttribute('role','status');const hintText=el('span','','Choose furniture, then click the ground');const hintCoords=el('small','','');hint.append(hintText,hintCoords);root.append(hint);
 // Sheet-local feedback remains readable when compact layouts hide the world hint.
 const sheetFeedback=[tray,terrainTray,inspectorShell,moreTray].map(sheet=>{const feedback=el('div','editor-polish-feedback');feedback.setAttribute('role','status');sheet.append(feedback);return feedback;});
 const recovery=el('div','builder-recovery');recovery.hidden=true;const recoveryText=el('span');const exportBtn=button('Export my draft',()=>exportScene());const discard=button('Revert',()=>revert());const reviewBtn=button('Review changes',()=>openReview());recovery.append(recoveryText,reviewBtn,exportBtn,discard);root.append(recovery);
 const reviewSheet=el('section','builder-conflict-review');reviewSheet.hidden=true;reviewSheet.tabIndex=-1;reviewSheet.setAttribute('role','dialog');reviewSheet.setAttribute('aria-modal','true');reviewSheet.ariaLabel='Review conflicting room changes';const reviewTop=el('div','builder-tray-top');reviewTop.append(el('strong','','Review room changes'),button('Cancel',()=>closeReview(),'Cancel review and keep my draft'));const reviewBody=el('div','builder-conflict-body'),reviewActions=el('div','builder-conflict-actions');const applyReview=button('Use reviewed choices',()=>resolveReview());reviewActions.append(button('Export my draft',()=>exportScene()),applyReview);reviewSheet.append(reviewTop,reviewBody,reviewActions);root.append(reviewSheet);
 const help=el('details','builder-keyhelp');const helpTitle=el('summary','','?  Keyboard & controls');help.append(helpTitle);const helpCopy=el('div','','V select · X erase · R rotate · D duplicate\nArrow keys move a preview or nudge selection\nTerrain: drag a rectangle · Shift+arrows resize · R swaps sides\nSelected area: Shift+arrows resize\nFloating images: Free position / Grid toggles snapping\nSpace / Enter places · [ / ] select previous / next item\nDelete erases · Esc cancels, then leaves Build\nCtrl/Cmd+Z undo · Shift+Z redo · Ctrl/Cmd+S save\nTab reaches every tool · Enter activates buttons\nRight-drag / two fingers orbit · Wheel zooms');help.append(helpCopy);root.append(help);
 const importInput=el('input');importInput.type='file';importInput.accept='.json,application/json';importInput.hidden=true;importInput.onchange=()=>importScene(importInput.files[0]);root.append(importInput);

 // Image definitions are a room-scoped read projection, never part of scene JSON.
 function bindServerRoom(room){if(room?.scene){bindImageDefinitions(room.scene,room.imageDefinitions||{},room.id);bindCompositionDefinitions(room.scene,room.compositionDefinitions||{},room.id);}return room;}
 function bindDraft(room,scene,{preserve=true}={}){
  if(!scene||!room)return scene;
  bindCompositionDefinitions(scene,{...(preserve?compositionDefinitions(scene):{}),...room.compositionDefinitions},room.id);
  const previous=preserve?Object.fromEntries(Object.entries(imageDefinitions(scene)).filter(([,entry])=>entry.definition.roomId===room.id)):{};
  bindImageDefinitions(scene,mergeImageDefinitions(previous,room.imageDefinitions),room.id);for(const item of scene.objects||[])if(item.type==='image')item.assetRef=validateAssetReference(item.assetRef);return scene;
 }
 function acceptRoomMetadata(room){
  const state=getState();if(!state.room||state.room.id!==room.id)return;
  for(const k of ['personalAreas','capabilities','role'])if(room[k]!==undefined)state.room[k]=room[k];
  for(const k of ['sceneOperations','sceneOperationsV2'])state.room[k]=room[k]??null;
  const retained=Object.fromEntries(Object.entries(mergeImageDefinitions(state.room.imageDefinitions,imageDefinitions(state.scene))).filter(([,entry])=>entry?.definition?.roomId===room.id));
  state.room.imageDefinitions=mergeImageDefinitions(retained,room.imageDefinitions);
  state.room.compositionDefinitions={...state.room.compositionDefinitions,...room.compositionDefinitions};
  bindDraft(state.room,state.scene);
 }
 // Scene revisions order committed geometry; live authority can change at the
 // same revision. Keep those observations separate until the save settles.
 const protocolKeys=['sceneOperations','sceneOperationsV2'],metadataKeys=['personalAreas','capabilities','role','compositionDefinitions',...protocolKeys];
 const admissionIdentity=()=>{const state=getState();return [state.admissionId,state.admissionEpoch,state.admissionRevision];};
 function roomMetadata(room){return Object.fromEntries(metadataKeys.filter(key=>protocolKeys.includes(key)||room?.[key]!==undefined).map(key=>[key,clone(room?.[key]??null)]));}
 function newerScene(a,b){return b?.scene&&(!a?.scene||Number(b.revision)>Number(a.revision))?clone(b):a;}
 function saveCurrent(operation=pendingSave){const state=getState();return !!operation&&operation.epoch===saveEpoch&&operation.roomEpoch===roomEpoch&&operation.roomId===roomId&&operation.roomId===state.room?.id&&operation.actorId===state.user?.id&&same(operation.admission,admissionIdentity());}
 function retireSave(){pendingSave=null;retrySave=null;saving=false;saveEpoch++;}
 function saveInProgress(){if((pendingSave&&!saveCurrent())||(retrySave&&!saveCurrent(retrySave)))retireSave();return saving;}
 function reconciledRoom(room,operation){
  const state=getState(),metadata={...operation?.metadata};
  // The shell can also update authority without dispatching a scene snapshot.
  if(operation)for(const key of metadataKeys)if(Object.hasOwn(metadata,key)||!same(state.room[key],operation.initialMetadata[key]))metadata[key]=state.room[key];
  return {...room,...metadata,compositionDefinitions:{...room.compositionDefinitions,...state.room.compositionDefinitions,...compositionDefinitions(state.scene)},imageDefinitions:mergeImageDefinitions(room.imageDefinitions,state.room.imageDefinitions,imageDefinitions(state.scene))};
 }
 function activeImage(){return gesture?.item||copyTemplate||(tool==='image'&&imageAsset?{type:'image',assetRef:imageAsset}:null)||itemById(selected);}
 function floatingImage(item){return item?.type==='image'&&resolvedImage(getScene(),item)?.version.floating===true;}
 function placementStep(item){return floatingImage(item)&&!imageSnap?0:snap;}
 function positionFor(point,item){if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.z))return null;return placementStep(item)?snapPoint(point,snap):{x:point.x,z:point.z};}
 function imageInstance(item){return {...item,assetRef:validateAssetReference(item.assetRef)};}
 function mode(){onModeChange({tool,selected,dragging:!!gesture?.dragged,snap:strokeTool()?1:placementStep(activeImage()),enabled});}
 function emitGhost(value){preview=value;onGhost(value);if(value?.kind==='terrain'){hint.classList.toggle('invalid',!value.valid);hintCoords.textContent=`${value.width} × ${value.depth} m`;message(value.valid?(gesture?'Release to '+(value.erase?'restore ground':'paint')+' · Esc cancels':'Drag a rectangle · Shift+arrows resize · Space places'):value.reason);return;}if(value?.type==='wall'&&tool==='wall-draw'){hint.classList.toggle('invalid',!value.valid);hintCoords.textContent=`${value.width} m wall`;message(value.valid?'Drag a straight wall · Release to build · Select to move':value.reason);return;}if(value){hint.classList.toggle('invalid',!value.valid);hintCoords.textContent=`${value.x.toFixed(1)}, ${value.z.toFixed(1)} · ${value.rotation||0}° · ${value.snap?'Grid '+value.snap+'m':'Free position'}`;message(value.valid?(value.kind==='move'?'Release to move · Esc cancels':value.kind==='duplicate'?(touchUI()?'Tap to place a copy · Select cancels':'Click to place a copy · Esc cancels'):(touchUI()?'Tap to place · Rotate turns it · Select finishes':'Click to place · R rotates · Esc selects')):value.reason);}else{hint.classList.remove('invalid');hintCoords.textContent=selected&&itemById(selected)?(placementStep(itemById(selected))?'Grid '+snap+'m':'Free position'):'';message(tool==='select'&&selected&&itemById(selected)?'Selected '+itemById(selected).name+' · Drag to move · '+(touchUI()?'Rotate turns it':'R rotates · D duplicates'):tool==='select'?(touchUI()?'Tap to select · Drag to move · Two fingers to look around':'Click to select · Drag to move · Right-drag to look around'):tool==='erase'?(touchUI()?'Tap an item to erase · Undo restores it':'Click an item to erase · Undo restores it'):terrainTool()?'Drag ground to paint a rectangle · Undo is always available':tool==='wall-draw'?'Drag ground to draw one straight wall':'Move onto the room to preview · R rotates');}}
 function message(text){
  if(lastMessage!==text){lastMessage=text;hintText.textContent=text;}
  for(const feedback of sheetFeedback){const copy=text+(hintCoords.textContent?' · '+hintCoords.textContent:'');if(feedback.textContent!==copy)feedback.textContent=copy;feedback.classList.toggle('invalid',hint.classList.contains('invalid'));feedback.hidden=feedback.parentElement===inspectorShell&&!selected&&!hint.classList.contains('invalid');}
 }
 // Describe the actual rebased history snapshots; never add metadata to saved scenes.
 function historyLabel(from,to){
  if(!from||!to)return '';
  const {changes}=sceneChanges(from,to,{version:2});
  if(changes.length===1){const c=changes[0],a=c.before,b=c.after;
   if(c.kind==='object'||c.kind==='area'){
    const name=(b||a)?.name||(c.kind==='area'?'area':'item');
    if(!a)return 'Add '+name;if(!b)return 'Delete '+name;
    const fields=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>!same(a[k],b[k]));
    return (fields.every(k=>['x','z'].includes(k))?'Move ':fields.length===1&&fields[0]==='rotation'?'Rotate ':fields.length===1&&fields[0]==='name'?'Rename ':'Edit ')+name;
   }
   if(c.kind==='scene')return 'Change '+c.field;
  }
  if(changes.length&&changes.every(c=>c.kind==='terrain'))return 'Edit terrain';
  return 'Edit room';
 }
 function updateHistoryFeedback(){
  for(const [b,entries,label,shortcut,from,to] of [[undo,history,'Undo','Ctrl/Cmd+Z',history.at(-1)?.scene,getScene()],[redo,future,'Redo','Ctrl/Cmd+Shift+Z',getScene(),future.at(-1)?.scene]]){
   let cached=historyFeedbackCache.get(b);
   if(!cached||cached.from!==from||cached.to!==to){cached={from,to,description:entries.length?historyLabel(from,to):''};historyFeedbackCache.set(b,cached);}
   const description=cached.description;
   b.title=description?label+' '+description+' ('+shortcut+')':'Nothing to '+label.toLowerCase();
   b.setAttribute('aria-description',description?description+' · '+entries.length+' available':b.title);
   b.querySelector('.builder-extra-label').textContent=label+(compact&&description?' · '+description:entries.length?' · '+entries.length:'');
  }
 }
 function terrainOptions(){return {material:terrainMaterial,blocked:terrainBlocked,erase:tool==='terrain-erase'};}
 function currentTerrainRect(point=lastHit?.point){
  if(!point)return null;const end=terrainCell(point);if(gesture?.startCell)return terrainRect(gesture.startCell,end);
  return terrainRect(end,{x:end.x+terrainSize.width-1,z:end.z+terrainSize.depth-1});
 }
 function terrainCheck(rect){
  const scene=getScene(),position=getState().position,options=terrainOptions(),key=JSON.stringify([rect,options,position]);
  if(terrainValidation?.scene===scene&&terrainValidation.key===key)return terrainValidation.result;
  const result=roomPermission()?validateTerrainEdit(scene,rect,options,{position}):{valid:false,reason:'Only room owners and editors can change terrain'};terrainValidation={scene,key,result};return result;
 }
 function terrainGhost(rect){const {valid,reason}=terrainCheck(rect);return {type:'terrain',kind:'terrain',x:(rect.minX+rect.maxX+1)/2,z:(rect.minZ+rect.maxZ+1)/2,width:rect.maxX-rect.minX+1,depth:rect.maxZ-rect.minZ+1,...terrainOptions(),valid,reason,snap:1};}
 function wallCandidate(point=lastHit?.point){
  if(!point)return null;if(gesture?.point)return wallFromStroke(gesture.point,point,rotation);
  return {...wallFromStroke(point,point,rotation),width:terrainSize.width};
 }
 function commitTerrain(rect){
  if(!roomPermission()||getState().room?.id!==roomId)return false;if(tool==='terrain-erase'&&!getScene().terrain){refreshPreview();return false;}const check=terrainCheck(rect);if(!check.valid){emitGhost(terrainGhost(rect));return false;}
  const changed=mutate(scene=>{scene.terrain=check.terrain;});refreshPreview();return changed;
 }
 function commitWall(candidate){
  if(!candidate||!roomPermission()||getState().room?.id!==roomId)return false;const ghost=ghostFor(candidate,'place',null);if(!ghost.valid){emitGhost(ghost);return false;}
  const changed=mutate(scene=>scene.objects.push({...candidate,id:'wall-'+uid()}));refreshPreview();return changed;
 }
 function candidateFor(point){
  const p=positionFor(point,activeImage());if(!p)return null;
  if(copyTemplate){if(copyTemplate.type==='image'&&resolvedImage(getScene(),copyTemplate)?.status!=='active')return null;const copy={...clone(copyTemplate),...p,rotation};if(copy.type==='composition')return {...copy,id:'composition-preview'};return copy.type==='image'?imageInstance({...copy,id:'image-preview'}):copy;}
  if(tool==='image'&&imageAsset){const entry=resolvedImage(getScene(),{assetRef:imageAsset});return entry?.status==='active'?{id:'image-preview',type:'image',assetRef:imageAsset,name:imageLibraryMetadata(entry).name,...p,rotation,actions:[]}:null;}
  if(tool==='composition'&&compositionAsset)return {id:'composition-preview',type:'composition',assetRef:compositionAsset,name:compositionName,...p,rotation};
  if(tool==='area')return {type:'area',name:'New area',...p,width:4,depth:4,rotation:0,action:'welcome',message:'Welcome to this area'};
  if(CATALOG[tool])return {type:tool,name:CATALOG[tool].name,...p,rotation};return null;
 }
 function ghostFor(item,kind='place',excludeId){const scene=getScene(),definitions=imageDefinitions(scene),position=getState().position,key=JSON.stringify([item.type,item.assetRef,item.x,item.z,item.width,item.depth,item.rotation,excludeId,position?.x,position?.z]);let validity;if(validationCache?.scene===scene&&validationCache.definitions===definitions&&validationCache.key===key)validity=validationCache.result;else{validity=validatePlacement(scene,item,{excludeId,position});validationCache={scene,definitions,key,result:validity};}const policyError=!roomPermission()&&policy().validateItem?.(item,excludeId?getScene().objects.find(o=>o.id===excludeId):null);if(policyError)validity={valid:false,reason:policyError};return {...item,type:item.type||'area',...validity,kind,snap:placementStep(item),...(excludeId?{sourceId:excludeId}:{})};}
 function refreshPreview(){if(!active()||saving){emitGhost(null);return;}if(strokeTool()&&!roomPermission()){cancelGesture();return;}if(terrainTool()){const rect=currentTerrainRect();emitGhost(rect?terrainGhost(rect):null);return;}if(tool==='wall-draw'){const item=wallCandidate();emitGhost(item?ghostFor(item,'place',null):null);return;}const item=candidateFor(lastHit?.point);emitGhost(item?ghostFor(item,copyTemplate?'duplicate':tool==='area'?'area':'place',null):null);}
 function attachRoom(){const state=getState();enabled=!root.hidden;const changedRoom=roomId!==state.room?.id||actorId!==state.user?.id||!same(admission,admissionIdentity());if(!changedRoom&&saveCurrent()){Object.assign(pendingSave.metadata,roomMetadata(state.room));pendingSave.committed=newerScene(pendingSave.committed,state.room);}bindServerRoom(state.room);bindDraft(state.room,state.scene,{preserve:!changedRoom});if(changedRoom){roomEpoch++;retireSave();closeReview({record:false,restore:false});review=null;reviewChoices={};forceLegacy=false;historyNotice='';actorId=state.user?.id;admission=admissionIdentity();pointerControl=null;deferredInspector=false;roomId=state.room?.id;base=clone(state.scene);history=[];future=[];selected=null;dirty=false;tool='select';conflictRoom=null;saveError='';gesture=null;copyTemplate=null;imageAsset=null;compositionAsset=null;imageSnap=false;roomSettings=false;moreOpen=false;terrainOpen=false;terrainSize={width:1,depth:1};terrainValidation=null;lastHit=null;inspectorKey='';emitGhost(null);}update();mode();}
 // A same-room reconnect may issue a fresh admission after a server restart.
 // The shell retains state.scene until this fenced handover has reconciled it.
 function resumeAdmission(room){
  const state=getState(),next=admissionIdentity();
  if(!state.ready||!room?.scene||room.id!==roomId||state.room?.id!==roomId||state.user?.id!==actorId||!base||typeof next[0]!=='string'||!next[0]||typeof next[1]!=='string'||!next[1]||!Number.isSafeInteger(next[2])||next[2]<1||!Number.isSafeInteger(room.revision)||room.revision<0)return false;
  flushFields();const unresolved=pendingSave||retrySave,reference=unresolved?.kind==='operations'?reconnectDraftReference({base,submitted:unresolved.scene,mine:getScene(),server:room.scene,version:unresolved.body?.version||unresolved.version||1}):review?.reference||base;cancelGesture();closeReview({record:false,restore:false});roomEpoch++;retireSave();admission=next;pointerControl=null;deferredInspector=false;history=[];future=[];historyNotice='Earlier undo history was cleared after reconnecting. Your draft is retained.';
  reconcileRoom(room,{reference});return true;
 }
 function setBuild(value){if(!value){flushFields();closeReview({record:false,restore:false});}enabled=!!value;if(!value)cancelGesture();else update();mode();}
 function record(before,selection=selected){history.push({scene:before,selected:selection});if(history.length>80)history.shift();future=[];dirty=!same(getScene(),base);saveError='';onSelect(selected);update();}
 function mutate(fn,{validateId=null,inspect=true,previousSelection=selected}={}){
  if(saving)return false;if(!permission()){toast('Only room owners and editors can build');return false;}
  const before=clone(getScene()),next=clone(before),previous=previousSelection;fn(next);for(const item of next.objects)if(item.type==='image')item.assetRef=validateAssetReference(item.assetRef);
  const denied=changeError(before,next);if(denied){toast(denied);update();return false;}
  if(validateId){const v=[...next.objects,...next.areas].find(o=>o.id===validateId);if(v?.start)try{validateStarts(next);}catch(error){toast(error.message);update();return false;}const check=v&&validatePlacement(next,v,{excludeId:v.id,position:getState().position});if(check&&!check.valid){toast(check.reason);update();hint.classList.add('invalid');message(check.reason);return false;}}
  if(same(before,next))return false;onScene(next);record(before,previous);if(!gesture&&tool==='select')emitGhost(null);if(!inspect)update({inspect:false});return true;
 }
 function setCompositionAsset(ref,name='Furniture'){const state=getState();const definition=compositionDefinitions(state.scene)[ref.assetId+':'+ref.revision];if(!definition){toast('Open this saved furniture in the workshop first');return false;}compositionAsset={assetId:ref.assetId,revision:ref.revision};compositionName=name;rotation=0;setTool('composition');return true;}
 function replaceCompositionAsset(id,ref,name){const item=itemById(id);if(item?.type!=='composition')return false;return mutate(s=>{const target=s.objects.find(v=>v.id===id);target.assetRef={...ref};target.name=name||target.name;},{validateId:id});}
 function setTool(value){if(['terrain','terrain-erase','wall-draw'].includes(value)&&!roomPermission()){toast('Only room owners and editors can change terrain');return false;}if(value==='composition'&&!compositionAsset){toast('Choose saved furniture from the workshop first');return false;}if(value==='image'&&!imageAsset){toast('Choose a committed image from Custom images first');return false;}flushFields();if(value==='area'&&!roomPermission()){toast('Only room editors can create areas');return;}cancelGesture();tool=value;moreOpen=false;copyTemplate=null;selected=null;onSelect(null);roomSettings=false;trayOpen=false;terrainOpen=strokeTool();if(CATALOG[value]||value==='area'||value==='image'||value==='composition'||strokeTool())ensureKeyboardPoint();refreshPreview();update();mode();focusCanvas();}
 function setImageAsset(reference){
  if(saving||!permission()||getState().room?.id!==roomId)return false;
  let ref,entry;try{ref=validateAssetReference(reference);entry=resolvedImage(getScene(),{assetRef:ref});}catch{}
  if(!entry||entry.status!=='active'||entry.definition.roomId!==roomId){toast('This image version is unavailable. Refresh Custom images and choose it again.');return false;}
  imageAsset=ref;imageSnap=false;rotation=0;setTool('image');return true;
 }
 function renderSearch(){const query=search.value.trim().toLowerCase();results.replaceChildren();for(const b of catalog.querySelectorAll('button'))b.hidden=query&&!((CATALOG[b.dataset.tool].name+' '+b.dataset.tool).toLowerCase().includes(query));if(!query)return;const matches=[...(getScene()?.objects||[]),...(getScene()?.areas||[])].filter(o=>(o.name+' '+(o.type||'area')+' '+(o.text||'')).toLowerCase().includes(query)).slice(0,8);if(matches.length)results.append(el('small','','ALREADY IN THIS ROOM'));for(const item of matches)results.append(button(item.name,()=>{select(item.id);trayOpen=false;update({inspect:false});}));}
 function update({inspect=true}={}){
  saveInProgress();if(inspect&&!flushing)flushFields();
  const canEdit=permission();if(strokeTool()&&!roomPermission()){cancelGesture();tool='select';terrainOpen=false;}dirty=!!retrySave||!!review||!!base&&(!same(getScene(),base)||pendingFields());renderSearch();
  status.textContent=retrySave?'Save outcome unknown · retry the same save':conflictRoom?'A newer room version needs your attention':saving?'Saving to this room…':saveError?'Save failed · your draft is safe':dirty?'Unsaved changes · save when ready':'All changes saved';
  if(reviewOpen&&review)applyReview.disabled=review.conflicts.some(c=>!reviewChoices[c.key])||!canEdit;
  status.classList.toggle('dirty',dirty);status.classList.toggle('error',!!saveError||!!conflictRoom);
  updateHistoryFeedback();
  undo.disabled=!history.length||saving||!canEdit;redo.disabled=!future.length||saving||!canEdit;save.disabled=(!dirty&&!retrySave)||saving||!canEdit;save.textContent=saving?'Saving…':retrySave?'Retry save':review?'Review changes':compact?'Save':'Save room';save.ariaLabel=retrySave?'Retry save':review?'Review changes':'Save room';
  discard.textContent=conflictRoom?'Load server version':'Revert to saved';discard.disabled=!dirty||saving;
  recovery.hidden=!conflictRoom&&!saveError&&!retrySave&&!historyNotice;reviewBtn.hidden=!review;reviewBtn.disabled=saving||!!retrySave;discard.disabled=discard.disabled||!!retrySave;recoveryText.textContent=retrySave?'The result is unknown. Retry sends the exact same save once; your current draft is kept.':review?'Your draft is unchanged. Review the differences, keep editing, or export a copy.':conflictRoom?'Your edits are safe here. Export them before loading the newer room.':saveError||historyNotice;
  for(const b of [selectBtn,eraseBtn,addBtn,customBtn,areaBtn,rotateBtn,duplicateBtn,snapBtn])b.disabled=saving||!canEdit;
  terrainBtn.disabled=saving||!roomPermission();terrainTray.hidden=!terrainOpen;
  for(const b of materials.querySelectorAll('button')){b.disabled=saving||!roomPermission();b.classList.toggle('active',terrainTool()&&tool!=='terrain-erase'&&b.dataset.material===terrainMaterial);b.setAttribute('aria-pressed',String(terrainTool()&&tool!=='terrain-erase'&&b.dataset.material===terrainMaterial));}
  for(const b of [wallDrawBtn,terrainEraseBtn]){b.disabled=saving||!roomPermission();b.classList.toggle('active',b.dataset.tool===tool);b.setAttribute('aria-pressed',String(b.dataset.tool===tool));}
  blockedInput.checked=terrainBlocked;blockedInput.disabled=saving||!roomPermission()||!terrainTool()||tool==='terrain-erase';terrainBtn.classList.toggle('active',terrainOpen||strokeTool());
  terrainNote.textContent=(terrainMaterial==='water'&&tool==='terrain'?'Water · No swimming. ':'')+(tool==='wall-draw'?'One straight wall per drag. Select it to move or rotate.':tool==='terrain-erase'?'Restores the original room ground.':(terrainBlocked?'Blocks walking. ':'Walkable. '))+(!terrainTool()?'':' '+(getScene()?.terrain?.cells.length||0)+' / '+MAX_TERRAIN_CELLS.toLocaleString()+' cells');
  areaBtn.disabled=saving||!roomPermission();settingsBtn.disabled=saving||!roomPermission();
  rotateBtn.disabled=saving||!permission()||(selected&&!itemPermission(itemById(selected)))||(!selected&&!CATALOG[tool]&&tool!=='image'&&tool!=='composition'&&!strokeTool()&&!copyTemplate);duplicateBtn.disabled=saving||!selected||!itemPermission(itemById(selected))||(itemById(selected)?.type==='image'&&resolvedImage(getScene(),itemById(selected))?.status!=='active');
  for(const b of catalog.querySelectorAll('button')){b.classList.toggle('active',b.dataset.tool===tool);b.disabled=saving||!canEdit;}
  selectBtn.classList.toggle('active',tool==='select');eraseBtn.classList.toggle('active',tool==='erase');areaBtn.classList.toggle('active',tool==='area');addBtn.classList.toggle('active',trayOpen||!!CATALOG[tool]);settingsBtn.classList.toggle('active',roomSettings);customBtn.classList.toggle('active',tool==='image');const floating=floatingImage(activeImage());snapBtn.disabled=saving||!canEdit||strokeTool();snapBtn.textContent=strokeTool()?'Grid 1m':floating&&!imageSnap?'Free position':'Grid '+snap+'m';snapBtn.title=floating?'Floating image: cycle free position, 1 metre grid, and half-metre grid':'Toggle 1 metre / half-metre snapping';snapBtn.setAttribute('aria-label',floating?'Image placement: '+snapBtn.textContent:snapBtn.textContent);
  for(const [b,pressed] of [[selectBtn,tool==='select'],[eraseBtn,tool==='erase'],[areaBtn,tool==='area'],[customBtn,tool==='image']])b.setAttribute('aria-pressed',String(pressed));
  addBtn.setAttribute('aria-expanded',String(trayOpen));terrainBtn.setAttribute('aria-expanded',String(terrainOpen));settingsBtn.setAttribute('aria-expanded',String(roomSettings));
  tray.hidden=!trayOpen;inspectorShell.hidden=(!selected&&!roomSettings)||compact&&(trayOpen||terrainOpen||moreOpen);
  belt.setAttribute('aria-description',compact?'More opens erase, custom images, undo, redo and grid controls.':'Scroll horizontally if needed; Tab brings each control into view.');
  moreTray.hidden=!compact||!moreOpen;moreBtn.setAttribute('aria-expanded',String(compact&&moreOpen));rotateBtn.hidden=compact&&rotateBtn.disabled;
  sheetFeedback[2].hidden=!selected&&!hint.classList.contains('invalid');
  root.dataset.sheet=trayOpen?'furniture':terrainOpen?'terrain':compact&&moreOpen?'more':!inspectorShell.hidden?'inspector':'none';inspectorTitle.textContent=selected?(itemById(selected)?.name||'Item details'):'Room settings';
  if(inspect&&!flushing){if(pointerControl?.isConnected)deferredInspector=true;else renderInspectorStable();}for(const input of inspector.querySelectorAll('input,select,textarea,button'))input.disabled=saving||!canEdit||(!roomPermission()&&(!selected||!getScene().objects.some(o=>o.id===selected)||!itemPermission(itemById(selected))))||input.dataset.unavailable==='true'||input.dataset.savedArrival==='true'&&(!canTrySavedArrival(selected)||dirty);
  root.dataset.tool=tool;root.dataset.dragging=String(!!gesture?.dragged);root.dataset.dirty=String(dirty);
  window.dispatchEvent(new CustomEvent('editor-status',{detail:{dirty,saving}}));
 }
 function pendingFields(){return [...inspector.querySelectorAll('input,textarea,select')].some(input=>input._pending?.());}
 function flushFields(){if(flushing)return;flushing=true;try{for(const input of [...inspector.querySelectorAll('input,textarea,select')])input._commit?.();}finally{flushing=false;}}
 function renderInspectorStable(){
  const oldScroll=inspector.scrollTop,focus=document.activeElement,focusKey=inspector.contains(focus)?focus.dataset.focusKey:null,focusLabel=inspector.contains(focus)?focus.closest('label')?.querySelector('span')?.textContent:null,focusButton=inspector.contains(focus)&&focus.tagName==='BUTTON'?{label:focus.getAttribute('aria-label'),text:focus.textContent,title:focus.title}:null,start=focus?.selectionStart,end=focus?.selectionEnd;
  const key=selected||'room';if(key!==inspectorKey)inspector.scrollTop=0;const detailsOpen=[...inspector.querySelectorAll('details')].filter(d=>d.open).map(d=>d.dataset.section);renderInspector();
  if(key===inspectorKey){inspector.scrollTop=oldScroll;for(const d of inspector.querySelectorAll('details'))if(detailsOpen.includes(d.dataset.section))d.open=true;
   let field=focusKey?[...inspector.querySelectorAll('[data-focus-key]')].find(e=>e.dataset.focusKey===focusKey):null;
   if(!field&&focusLabel&&!focusKey)field=[...inspector.querySelectorAll('label')].find(l=>l.querySelector('span')?.textContent===focusLabel)?.querySelector('input,textarea,select');
   if(!field&&focusButton&&!focusKey)field=[...inspector.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===focusButton.label&&b.textContent===focusButton.text&&b.title===focusButton.title);
   if(field){field.focus({preventScroll:true});try{field.setSelectionRange(start,end);}catch{}}
  }inspectorKey=key;
 }
 function field(label,value,onChange,{type='text',min,max,step,options,key=label}={}){
  const wrap=el('label','field');wrap.append(el('span','',label));const input=el(options?'select':type==='textarea'?'textarea':'input');input.dataset.focusKey=key;
  if(!options){if(type!=='textarea')input.type=type;input.value=value??'';if(min!=null)input.min=min;if(max!=null)input.max=max;if(step!=null)input.step=step;}else{for(const [val,name]of options){const op=el('option','',name);op.value=val;input.append(op);}input.value=value??'';}
  let committed=input.value;const capturedRoom=roomId,capturedEpoch=roomEpoch,capturedSelection=selected;
  const current=()=>roomId===capturedRoom&&getState().room?.id===capturedRoom&&roomEpoch===capturedEpoch&&selected===capturedSelection;
  input._pending=()=>current()&&input.value!==committed;
  input._commit=()=>{if(!input._pending())return;committed=input.value;onChange(type==='number'?Number(input.value):input.value);};
  input.onchange=input._commit;input.oninput=()=>{if(current())update({inspect:false});};wrap.append(input);return wrap;
 }
 function details(title,key){const d=el('details','builder-details');d.dataset.section=key;d.append(el('summary','',title));return d;}
 function renderInspector(){
  for(const picker of destinationPickers)picker.destroy();destinationPickers=[];inspector.replaceChildren();const scene=getScene();if(!scene)return;
  const o=scene.objects.find(o=>o.id===selected),a=scene.areas.find(a=>a.id===selected),v=o||a;
  if(!v){
   inspector.append(el('p','panel-hint','Changes stay in your draft until you Save. Undo uses your available edit history.'));
   inspector.append(field('Environment',scene.theme,v=>mutate(s=>s.theme=v),{options:[['garden','Garden'],['studio','Studio'],['assembly','Assembly']]}));
   inspector.append(el('h3','','Interactive areas'));const areas=el('div','area-list');for(const area of scene.areas)areas.append(button('▱ '+area.name,()=>select(area.id)));if(!scene.areas.length)areas.append(el('p','panel-hint','Add an area to give a place a purpose.'));inspector.append(areas);
   inspector.append(button('Set arrival at my position',()=>{const p=getState().position;if(!canStand(scene,p.x,p.z,.75)){toast('Choose an open spot with room for arriving visitors');return;}mutate(s=>s.spawn={x:p.x,z:p.z});}));
   const files=details('Import, export and recovery','room-files');files.append(button('Export room',()=>exportScene()),button('Import JSON',()=>importInput.click()),button('Revert to last save',()=>revert()));inspector.append(files);return;
  }
  const selectedId=v.id;const patch=(k,val)=>mutate(s=>{const item=[...s.objects,...s.areas].find(i=>i.id===selectedId);if(item)item[k]=item.type==='image'&&['x','z'].includes(k)&&placementStep(item)?Math.round(val/snap)*snap:val;},{validateId:['x','z','rotation','width','depth'].includes(k)?selectedId:null});
  const summary=el('p','panel-hint editor-polish-selection-summary',a?'An invisible zone with real room behavior. Drag it to move.':'Drag this item in the room. R rotates it.');inspector.append(summary);
  const actions=el('div','editor-actions');if(o)actions.append(button('↻ Rotate',()=>rotate()));actions.append(button('Duplicate',()=>duplicate()),button('Delete',()=>remove()));inspector.append(actions);
  inspector.append(field('Name',v.name,val=>patch('name',val)));
  const row=el('div','field-row');row.append(field('X',v.x,val=>patch('x',val),{type:'number',step:placementStep(v)||.1}),field('Z',v.z,val=>patch('z',val),{type:'number',step:placementStep(v)||.1}));inspector.append(row);
  if(a){
   const size=el('div','field-row');size.append(field('Width',a.width,val=>patch('width',val),{type:'number',min:a.start ? .9 : .5,max:scene.bounds.width,step:.5}),field('Depth',a.depth,val=>patch('depth',val),{type:'number',min:a.start ? .9 : .5,max:scene.bounds.depth,step:.5}));inspector.append(size);
   inspector.append(field('On entry',a.action,val=>patch('action',val),{options:[['welcome','Show a message'],['silent','Silent / no calls'],['meeting','Meeting room'],['stage','Broadcast stage'],['audience','Broadcast audience'],['teleport','Teleport to room'],['link','Open a website prompt']]}));
   if(['meeting','stage','audience'].includes(a.action))inspector.append(field('Shared meeting name',a.meetingName||a.name,val=>patch('meetingName',val)));
   renderStartEditor(a,inspector);
   if(a.action==='teleport')renderDestinationPicker(a,inspector,'area-destination',destination=>mutate(s=>{const area=s.areas.find(v=>v.id===selectedId);if(area)assignDestination(area,destination);}));
   if(a.action==='link')inspector.append(field('Website URL',a.url||'',val=>patch('url',val),{type:'url'}));
   inspector.append(field('Area message',a.message||'',val=>patch('message',val),{type:'textarea'}));
   const personal=details('Personal space and ownership','personal-area');
   personal.append(field('Personal space mode',a.personalArea?.mode||'none',mode=>mutate(s=>{const target=s.areas.find(v=>v.id===selectedId);if(mode==='none')delete target.personalArea;else target.personalArea={mode,allowedTags:target.personalArea?.allowedTags||[]};}),{options:[['none','Shared area'],['dynamic','Eligible people can claim'],['static','Assign to an account']]}));
   if(a.personalArea){personal.append(field('Allowed world tags (any match)',(a.personalArea.allowedTags||[]).join(', '),value=>patch('personalArea',{...a.personalArea,allowedTags:[...new Set(value.split(',').map(v=>v.trim()).filter(Boolean))]})));personal.append(el('p','panel-hint','Empty tags allow any signed-in account to claim a dynamic space. Save this room before managing ownership.'),button('Manage ownership',()=>onManagePersonalArea(selectedId)));}
   inspector.append(personal);
   renderActionEditor(v,true,inspector);
  }else{
   inspector.append(field('Rotation',v.rotation||0,val=>patch('rotation',Number(val)),{options:[[0,'0°'],[90,'90°'],[180,'180°'],[270,'270°']]}));
   if(v.type==='composition'){const doc=resolvedComposition(scene,v);const summary=el('section','builder-image-summary');summary.append(el('strong','',doc?.asset.name||v.name),el('span','','Furniture revision '+v.assetRef.revision),el('p','panel-hint','This placed copy is pinned. Editing the source creates a new revision.'),button('Edit furniture source',()=>onOpenWorkshop({assetRef:v.assetRef,instanceId:v.id})));inspector.append(summary);
   }else if(v.type==='image'){
    const asset=resolvedImage(scene,v),summary=el('section','builder-image-summary');summary.ariaLabel='Custom image asset';
    summary.append(el('strong','',asset?imageLibraryMetadata(asset).name:'Unavailable image version'));
    summary.append(el('span','',asset?'Version '+asset.version.sequence+' · '+asset.version.versionId:'Version '+v.assetRef.versionId));
    if(asset){if(asset.status==='archived')summary.append(el('p','panel-hint','Archived image · Existing placement stays editable. Restore in Custom to place or duplicate.'));const version=asset.version;summary.append(el('span','',version.widthPixels+' × '+version.heightPixels+' px · '+imagePhysicalSize(version).widthMetres+' × '+imagePhysicalSize(version).heightMetres+' m'),el('p','panel-hint',version.floating?'Floating image · Free position by default. Use the Free position / Grid tool to snap.':'Collision image · Grid snapping keeps placement aligned with its source collision cells.'));}
    inspector.append(summary);
   }else{
    const appearance=details('Appearance & interaction','item-properties');appearance.append(field('Color',v.color||CATALOG[v.type]?.color||'#ffffff',val=>patch('color',val),{type:'color'}),field('Description',v.text||'',val=>patch('text',val),{type:'textarea'}),field('Open URL on interaction',v.url||'',val=>patchLegacyLink(v,val),{type:'url'}));if(v.type==='portal')renderDestinationPicker(v,appearance,'legacy-destination',destination=>patchLegacyTarget(v,destination));inspector.append(appearance);
   }
   if(v.type!=='composition'){renderActionEditor(v,false,inspector);renderDocuments(v,inspector);}
  }
 }
 function assignDestination(item,{target,entry}){item.target=target;if(entry)item.entry=entry;else delete item.entry;}
 function renderDestinationPicker(item,parent,keyPrefix,onChange,valueFor=()=>itemById(item.id)){
  const wrapper=el('div'),capturedRoom=roomId,capturedEpoch=roomEpoch,capturedItem=item.id,capturedScene=getScene();parent.append(wrapper);
  const current=()=>enabled&&!root.hidden&&roomId===capturedRoom&&roomEpoch===capturedEpoch&&getState().room?.id===capturedRoom&&selected===capturedItem&&getScene()===capturedScene&&!!valueFor();
  const editable=()=>!saving&&(roomPermission()||getScene().objects.some(object=>object.id===capturedItem))&&itemPermission(itemById(capturedItem));
  destinationPickers.push(mountDestinationPicker({root:wrapper,loadEntries:loadDestinationEntries,getRooms:getDestinationRooms,getValue:()=>{const value=valueFor();return {target:value?.target||'',...(value?.entry?{entry:value.entry}:{})};},onChange:destination=>{if(current()&&editable())onChange(destination);},isCurrent:current,isEnabled:editable,keyPrefix}));
 }
 function uniqueEntryKey(value){
  const stem=String(value||'arrival').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^[^a-z0-9]+/,'').slice(0,56)||'arrival',keys=new Set((getScene()?.areas||[]).map(area=>area.start?.key));
  if(!keys.has(stem))return stem;for(let suffix=2;suffix<1000;suffix++){const key=stem+'-'+suffix;if(!keys.has(key))return key;}return 'arrival-'+uid().slice(0,8);
 }
 function canTrySavedArrival(id){const saved=base?.areas?.find(area=>area.id===id);return enabled&&!root.hidden&&!!onTrySavedArrival&&!tryingArrival&&!!saved?.start&&roomPermission()&&!saving&&!conflictRoom&&!pendingFields()&&same(getScene(),base)&&getState().room?.id===roomId;}
 function renderStartEditor(area,parent){
  const section=el('section','builder-arrival');section.ariaLabel='Arrival region';section.append(el('h3','','Arrival region'));
  const capturedRoom=roomId,capturedEpoch=roomEpoch,capturedItem=area.id,current=()=>roomId===capturedRoom&&roomEpoch===capturedEpoch&&getState().room?.id===capturedRoom&&selected===capturedItem&&roomPermission();
  const edit=fn=>{if(current()){const changed=mutate(scene=>{const value=scene.areas.find(item=>item.id===capturedItem);if(value)fn(value);});if(!changed)update();}};
  section.append(field('Allow arrival here',String(!!area.start),value=>edit(item=>{if(value==='true'){if(item.width<.9||item.depth<.9){toast('Make an arrival region at least 0.9 × 0.9 metres.');return;}item.start={key:uniqueEntryKey(item.name),isDefault:false};}else delete item.start;}),{options:[['false','Off'],['true','Named arrival region']],key:'arrival:enabled'}));
  if(area.start){
   const key=field('Entry key',area.start.key,value=>edit(item=>{if(item.start)item.start.key=value;}),{key:'arrival:key'});key.querySelector('input').maxLength=64;key.querySelector('input').spellcheck=false;key.querySelector('input').autocapitalize='off';section.append(key);
   section.append(field('Default arrival',String(area.start.isDefault===true),value=>edit(item=>{if(item.start)item.start.isDefault=value==='true';}),{options:[['false','Use only when chosen'],['true','Include in default arrivals']],key:'arrival:default'}));
   const duplicate=getScene().areas.some(other=>other.id!==area.id&&other.start?.key===area.start.key),valid=typeof area.start.key==='string'&&ENTRY_KEY_RE.test(area.start.key)&&!duplicate;
   const hint=el('p','panel-hint'+(valid?'':' arrival-error'),valid?'The key stays the same when you rename this area. Several regions can be defaults.':duplicate?'Choose a unique entry key for this room.':'Use 1–64 lowercase letters, numbers, hyphens or underscores. Start with a letter or number.');hint.setAttribute('aria-live','polite');section.append(hint);
   const saved=base?.areas?.find(item=>item.id===area.id),committed=!!saved?.start&&same(saved,area);section.append(el('span','arrival-save-state',committed?'Saved arrival region':'Draft arrival · save room to use'));
   if(onTrySavedArrival){const tryButton=button('Try saved arrival',()=>{if(!current()||!canTrySavedArrival(capturedItem)){toast('Save this room before trying its arrival.');return;}const saved=base.areas.find(item=>item.id===capturedItem);const destination={roomId,entry:saved.start.key,revision:getState().room.revision,areaId:capturedItem};tryingArrival=true;update({inspect:false});Promise.resolve().then(()=>{if(!enabled||root.hidden||!current()||!same(getScene(),base)||pendingFields()||saving||conflictRoom)throw Error('Save this room before trying its arrival.');return onTrySavedArrival(destination);}).catch(error=>toast(error.message||'This arrival could not be tried.')).finally(()=>{tryingArrival=false;update({inspect:false});});},'Travel through the saved room arrival');tryButton.dataset.focusKey='arrival:try';tryButton.dataset.savedArrival='true';tryButton.disabled=!canTrySavedArrival(area.id);section.append(tryButton);}
  }
  parent.append(section);
 }
 function patchLegacyLink(v,url){mutate(s=>{const item=s.objects.find(i=>i.id===v.id);if(!item)return;if(Array.isArray(item.actions)&&url&&!item.actions.some(a=>a.id==='legacy-url')&&item.actions.length>=MAX_ACTIONS){toast('Remove an action before adding another link');return;}item.url=url;if(Array.isArray(item.actions)){const action=item.actions.find(a=>a.id==='legacy-url');if(action){if(url)action.url=url;else item.actions=item.actions.filter(a=>a.id!=='legacy-url');}else if(url)item.actions.push({...createAction('link','legacy-url'),url});}});}
 function patchLegacyTarget(v,destination){mutate(s=>{const item=s.objects.find(i=>i.id===v.id);if(!item)return;if(Array.isArray(item.actions)&&destination.target&&!item.actions.some(a=>a.id==='legacy-target')&&item.actions.length>=MAX_ACTIONS){toast('Remove an action before adding room travel');return;}assignDestination(item,destination);if(Array.isArray(item.actions)){const action=item.actions.find(a=>a.id==='legacy-target');if(action){if(destination.target)assignDestination(action,destination);else item.actions=item.actions.filter(a=>a.id!=='legacy-target');}else if(destination.target)item.actions.push({...createAction('teleport','legacy-target'),...destination});}});}
 function renderActionEditor(item,isArea,parent){
  const actions=isArea?(item.actions||[]):itemActions(item),section=details((isArea?'More actions':'Actions')+' · '+actions.length,isArea?'area-actions':'item-actions');
  section.append(el('p','panel-hint',isArea?'Actions appear in this order. Entry triggers start once when a visitor enters. Browser permission may require a click.':'Visitors choose one of these actions. Move actions up or down to set their menu order.'));
  const capturedRoom=roomId,capturedEpoch=roomEpoch,capturedItem=item.id;
  const edit=fn=>{if(capturedRoom!==roomId||capturedEpoch!==roomEpoch||getState().room?.id!==capturedRoom)return;mutate(s=>{const v=(isArea?s.areas:s.objects).find(v=>v.id===capturedItem);if(!v)return;const list=isArea?(v.actions??=[]):materializeItemActions(v);fn(list,v);});};
  for(const [index,action]of actions.entries()){
   const card=el('section','action-card');card.dataset.actionId=action.id;card.ariaLabel='Action '+(index+1)+': '+actionName(action);
   const heading=el('div','action-card-heading');heading.append(el('span','action-order',String(index+1)),el('strong','',actionName(action)),el('small','action-type',action.type));card.append(heading);
   const tools=el('div','editor-actions action-order-tools');
   for(const [delta,label]of [[-1,'Move up'],[1,'Move down']]){const b=button(label,()=>{edit(list=>{const i=list.findIndex(v=>v.id===action.id),next=i+delta;if(i<0||next<0||next>=list.length)return;[list[i],list[next]]=[list[next],list[i]];});},label+' action '+(index+1));b.ariaLabel=label+' action '+(index+1);b.dataset.focusKey=action.id+':move:'+delta;b.ariaDisabled=String(index+delta<0||index+delta>=actions.length);tools.append(b);}
   const remove=button('Delete action',()=>{edit(list=>{const i=list.findIndex(v=>v.id===action.id);if(i>=0)list.splice(i,1);});const next=inspector.querySelector('[data-action-id="'+(actions[index+1]?.id||actions[index-1]?.id||'')+'"] input')||inspector.querySelector('[data-focus-key="add:message"]');next?.focus({preventScroll:true});});remove.ariaLabel='Delete action '+(index+1);remove.dataset.focusKey=action.id+':delete';tools.append(remove);card.append(tools);
   const change=(key,value)=>edit(list=>{const entry=list.find(v=>v.id===action.id);if(entry)entry[key]=value;});
   const f=(label,key,options={})=>field(label,action[key],value=>change(key,value),{...options,key:action.id+':'+key});
   card.append(f('Action name','name'),f('Action description','description',{type:'textarea'}));
   if(isArea)card.append(field('Trigger',action.trigger||'interact',value=>change('trigger',value),{options:[['interact','Show an action button'],['enter','Start on area entry']],key:action.id+':trigger'}));
   if(action.type==='message')card.append(f('Message text','message',{type:'textarea'}));
   if(action.type==='link'||action.type==='audio')card.append(f('URL','url',{type:'url'}),f('Button label','label'));
   if(action.type==='link'){
    const protectedDocument=safeActionUrl(action.url)?.kind==='document';
    card.append(field('Open in',protectedDocument?'tab':action.mode||'tab',value=>change('mode',value),{options:protectedDocument?[['tab','Download protected document']]:[['tab','New browser tab'],['embed','Embedded website panel']],key:action.id+':mode'}));
    if(!protectedDocument&&(action.mode||'tab')==='embed')card.append(field('Panel width (%)',action.width??60,value=>change('width',value),{type:'number',min:30,max:90,step:5,key:action.id+':width'}),field('Close button',String(action.closable??true),value=>change('closable',value==='true'),{options:[['true','Show close button'],['false','Keep open until leaving']],key:action.id+':closable'}));
    if(protectedDocument)card.append(el('p','panel-hint','Downloads check the visitor’s current room access. Document metadata never grants access.'));
   }
   if(action.type==='audio')card.append(field('Volume',action.volume??.5,value=>change('volume',value),{type:'number',min:0,max:1,step:.1,key:action.id+':volume'}),field('Playback',String(action.loop??true),value=>change('loop',value==='true'),{options:[['true','Loop until stopped or leaving'],['false','Play once']],key:action.id+':loop'}));
   if(action.type==='teleport')renderDestinationPicker(item,card,action.id,destination=>edit((list,v)=>{const entry=list.find(a=>a.id===action.id);if(entry)assignDestination(entry,destination);if(!isArea&&action.id==='legacy-target')assignDestination(v,destination);}),()=>{const v=itemById(capturedItem);return v&&(isArea?v.actions:itemActions(v))?.find(a=>a.id===action.id);});
   section.append(card);
  }
  const add=el('div','editor-actions action-add');for(const type of ACTION_TYPES){const b=button(({message:'+ Message',link:'+ Link',audio:'+ Sound',teleport:'+ Travel'})[type],()=>edit(list=>{if(list.length>=MAX_ACTIONS){toast('An item or area can hold up to '+MAX_ACTIONS+' actions');return;}const action=createAction(type,uid());list.push(action);}));b.dataset.focusKey='add:'+type;b.dataset.unavailable=String(actions.length>=MAX_ACTIONS);add.append(b);}section.append(add);parent.append(section);
 }
 function assignDocument(item,file){if(item.type==='image'){
  if(safeActionUrl(file.url)?.kind!=='document'||file.url!=='/api/rooms/'+roomId+'/files/'+file.id){toast('This document has no protected room download link');return false;}
  const actions=materializeItemActions(item);if(actions.length>=MAX_ACTIONS){toast('Remove an action before attaching a document');return false;}
  actions.push({...createAction('link',uid()),url:file.url,name:('Download '+file.name).slice(0,120),label:'Download document',mode:'tab'});return true;
 }if(Array.isArray(item.actions)){let link=item.actions.find(a=>a.id==='legacy-url');if(!link){if(item.actions.length>=MAX_ACTIONS){toast('Remove an action before attaching a document');return false;}link=createAction('link','legacy-url');item.actions.push(link);}Object.assign(link,{url:file.url,name:'Download '+file.name,label:'Download document',mode:'tab'});}item.url=file.url;item.name=file.name.slice(0,120);item.document={id:file.id,name:file.name,size:file.size,contentType:file.contentType};return true;}
 function renderDocuments(v,parent){
  const docs=details(v.document?'Document · '+v.document.name:'Attach a room document','documents');const uploadInput=el('input');uploadInput.type='file';uploadInput.accept=FILE_ACCEPT;uploadInput.hidden=true;const capturedRoom=roomId,capturedItem=v.id,capturedEpoch=roomEpoch;
  const upload=button('Upload a document',()=>uploadInput.click());uploadInput.onchange=async()=>{const file=uploadInput.files[0];if(!file)return;upload.disabled=true;upload.textContent='Uploading…';try{const saved=await attachRoomFile({roomId:capturedRoom,file});if(roomId!==capturedRoom||roomEpoch!==capturedEpoch||!getScene().objects.some(o=>o.id===capturedItem)){toast('Uploaded to the original room. Select an item there to attach it.');return;}if(saving){toast('Document uploaded. Choose it from the list after saving.');return;}const attached=mutate(s=>{const item=s.objects.find(o=>o.id===capturedItem);if(item)assignDocument(item,saved);});if(attached)toast('Document attached to this draft. Save the room to keep it.');}catch(e){toast(e.message);}finally{upload.disabled=false;upload.textContent='Upload a document';uploadInput.value='';}};docs.append(upload,uploadInput);
  const savedList=el('select');savedList.ariaLabel='Saved room document';const placeholder=el('option','','Choose an uploaded document');placeholder.value='';savedList.append(placeholder);docs.append(savedList);
  savedList.onchange=()=>{if(roomId!==capturedRoom||roomEpoch!==capturedEpoch)return;const item=savedList._files?.find(f=>f.id===savedList.value);if(!item)return;mutate(s=>{const o=s.objects.find(o=>o.id===capturedItem);if(o)assignDocument(o,item);});};
  let loaded=false;docs.addEventListener('toggle',()=>{if(!docs.open||loaded)return;loaded=true;listRoomFiles(capturedRoom).then(result=>{if(!docs.isConnected)return;savedList._files=result.files||[];for(const file of savedList._files){const option=el('option','',file.name);option.value=file.id;savedList.append(option);}}).catch(()=>{loaded=false;});});if(v.document)docs.append(el('p','panel-hint','Attached: '+v.document.name+' · '+Math.ceil(v.document.size/1024)+' KB'));parent.append(docs);
 }
 function select(id){flushFields();cancelGesture();terrainOpen=false;trayOpen=false;moreOpen=false;tool='select';copyTemplate=null;selected=itemById(id)?id:null;roomSettings=false;onSelect(selected);update();refreshPreview();mode();}
 function pointerDown(hit,event={}){
  if(!active()||saving||!permission()||(event.button??0)!==0||getState().room?.id!==roomId)return false;
  if(strokeTool()&&!roomPermission()){cancelGesture();return false;}
  if(gesture&&event.pointerId!==undefined&&gesture.pointerId!==event.pointerId){cancelGesture();return false;}
  lastHit=hit;const client={x:event.clientX??0,y:event.clientY??0};
  if(strokeTool()){if(!hit?.point){cancelGesture();return false;}gesture={pointerId:event.pointerId,client,point:{...hit.point},startCell:terrainTool()?terrainCell(hit.point):null,dragged:false,roomId};}
  else if(tool==='select'){
   // Areas stay selectable through their visible outline/list without masking furniture.
   const id=hit?.id||areaAt(hit?.point)?.id;select(id);const item=itemById(selected);
   gesture={pointerId:event.pointerId,client,point:hit?.point?{...hit.point}:null,item:item?clone(item):null,dragged:false};
  }else gesture={pointerId:event.pointerId,client,point:hit?.point?{...hit.point}:null,dragged:false};
  refreshPreview();return true;
 }
 function pointerMove(hit,event={}){
  if(!active()||saving||getState().room?.id!==roomId||!permission()||(strokeTool()&&!roomPermission())){cancelGesture();return false;}lastHit=hit;
  if(gesture&&event.pointerId!==undefined&&gesture.pointerId!==undefined&&gesture.pointerId!==event.pointerId)return false;
  if(gesture){
   const distance=Math.hypot((event.clientX??gesture.client.x)-gesture.client.x,(event.clientY??gesture.client.y)-gesture.client.y);
   if(distance>6)gesture.dragged=true;
   if(strokeTool()){refreshPreview();root.dataset.dragging=String(gesture.dragged);mode();return true;}
   if(tool==='select'&&gesture.item&&gesture.dragged){
    if(!hit?.point||!gesture.point){emitGhost(null);return true;}
    const p=positionFor({x:gesture.item.x+hit.point.x-gesture.point.x,z:gesture.item.z+hit.point.z-gesture.point.z},gesture.item);
    emitGhost(ghostFor({...gesture.item,...p},'move',gesture.item.id));root.dataset.dragging='true';mode();return true;
   }
   if(gesture.dragged){emitGhost(null);return false;}
  }
  refreshPreview();return !!preview;
 }
 function pointerUp(hit,event={}){
  if(!active()||!gesture||saving||(event.button??0)!==0||getState().room?.id!==roomId||!permission()||(strokeTool()&&!roomPermission())){cancelGesture();return false;}
  if(event.pointerId!==undefined&&gesture.pointerId!==undefined&&gesture.pointerId!==event.pointerId)return false;
  pointerMove(hit,event);if(!gesture)return false;const completed=gesture,rect=terrainTool()?currentTerrainRect(hit?.point):null,wall=tool==='wall-draw'?wallCandidate(hit?.point):null;gesture=null;root.dataset.dragging='false';
  if(terrainTool()){if(rect)commitTerrain(rect);else emitGhost(null);mode();return true;}
  if(tool==='wall-draw'){if(wall)commitWall(wall);else emitGhost(null);mode();return true;}
  if(completed.dragged){
   if(tool==='select'&&completed.item&&preview?.kind==='move'){
    const target={x:preview.x,z:preview.z,rotation:preview.rotation};const check=validatePlacement(getScene(),{...completed.item,...target},{excludeId:completed.item.id,position:getState().position});
    if(check.valid)mutate(s=>{const item=[...s.objects,...s.areas].find(o=>o.id===completed.item.id);if(item)Object.assign(item,target);},{validateId:completed.item.id});else{emitGhost(null);message(check.reason+' · Move cancelled');hint.classList.add('invalid');mode();return true;}
   }
   emitGhost(null);mode();return true;
  }
  if(tool==='erase'){const id=hit?.id||areaAt(hit?.point)?.id;if(id)remove(id);return true;}
  if(tool==='select'){emitGhost(null);return true;}
  const candidate=candidateFor(hit?.point);if(!candidate){emitGhost(null);return false;}
  const check=validatePlacement(getScene(),candidate,{excludeId:null,position:getState().position});if(!check.valid){emitGhost(ghostFor(candidate,copyTemplate?'duplicate':'place',null));return true;}
  const wasCopy=!!copyTemplate,isArea=candidate.type==='area'||!candidate.type,id=(isArea?'area':candidate.type)+'-'+uid();const item={...candidate,id};delete item.sourceId;if(isArea){delete item.type;delete item.rotation;}
  const previous=selected;selected=id;
  if(!mutate(s=>(isArea?s.areas:s.objects).push(item))){selected=previous;return false;}
  if(wasCopy||isArea){copyTemplate=null;tool='select';emitGhost(null);}else refreshPreview();
  // Placing furniture stays fast; its detailed form is one Select click away.
  if(!wasCopy&&!isArea){selected=null;onSelect(null);}else onSelect(id);
  update();mode();return true;
 }
 function cancelGesture(){gesture=null;root.dataset.dragging='false';emitGhost(null);mode();}
 function pick(hit){if(!active())enabled=!root.hidden;pointerDown(hit,{button:0});return pointerUp(hit,{button:0});}
 function rotate(){
  if(saving||!permission())return;
  if(terrainTool()){if(gesture)cancelGesture();terrainSize={width:terrainSize.depth,depth:terrainSize.width};refreshPreview();return;}
  if(tool==='wall-draw'){if(gesture)cancelGesture();rotation=(rotation+90)%180;refreshPreview();return;}
  if(copyTemplate||CATALOG[tool]||tool==='image'||tool==='composition'){rotation=(rotation+90)%360;refreshPreview();return;}
  if(gesture?.dragged&&gesture.item?.type){gesture.item.rotation=((gesture.item.rotation||0)+90)%360;if(preview)emitGhost(ghostFor({...gesture.item,x:preview.x,z:preview.z},'move',gesture.item.id));return;}
  const item=itemById(selected);if(!item?.type)return;mutate(s=>{const o=s.objects.find(o=>o.id===selected);o.rotation=((o.rotation||0)+90)%360;},{validateId:selected});
 }
 function duplicate(){flushFields();const item=itemById(selected);if(!item||saving)return;if(item.type==='image'&&resolvedImage(getScene(),item)?.status!=='active'){toast('Restore this archived image in Custom before duplicating it.');return;}cancelGesture();moreOpen=false;copyTemplate=item.type==='image'?imageInstance(clone(item)):clone(item);delete copyTemplate.id;if(copyTemplate.start)copyTemplate.start={...copyTemplate.start,key:uniqueEntryKey(copyTemplate.start.key)};lastHit={point:{x:item.x,z:item.z}};rotation=item.rotation||0;tool='duplicate';trayOpen=false;selected=null;onSelect(null);ensureKeyboardPoint();refreshPreview();focusCanvas();update();mode();}
 function remove(id=selected){if(!id||saving||!itemById(id))return false;cancelGesture();const prev=selected;selected=null;const ok=mutate(s=>{s.objects=s.objects.filter(o=>o.id!==id);s.areas=s.areas.filter(o=>o.id!==id);},{previousSelection:prev});if(!ok)selected=prev;onSelect(selected);update();return ok;}
 function undoScene(){if(!history.length||saving||!permission())return;const denied=changeError(getScene(),history.at(-1).scene);if(denied){toast(denied);return;}cancelGesture();future.push({scene:clone(getScene()),selected});const prev=history.pop();onScene(bindDraft(getState().room,clone(prev.scene)));selected=prev.selected&&itemById(prev.selected)?prev.selected:null;tool='select';copyTemplate=null;saveError='';onSelect(selected);update();refreshPreview();mode();}
 function redoScene(){if(!future.length||saving||!permission())return;const denied=changeError(getScene(),future.at(-1).scene);if(denied){toast(denied);return;}cancelGesture();history.push({scene:clone(getScene()),selected});const next=future.pop();onScene(bindDraft(getState().room,clone(next.scene)));selected=next.selected&&itemById(next.selected)?next.selected:null;tool='select';copyTemplate=null;saveError='';onSelect(selected);update();refreshPreview();mode();}
 function revert(){if(retrySave||saveInProgress()||getState().room?.id!==roomId||getState().user?.id!==actorId||!same(admission,admissionIdentity()))return;cancelGesture();closeReview({record:false,restore:false});review=null;reviewChoices={};forceLegacy=false;historyNotice='';if(conflictRoom){conflictRoom=reconciledRoom({...conflictRoom,...roomMetadata(getState().room)});bindServerRoom(conflictRoom);acceptRoomMetadata(conflictRoom);base=clone(conflictRoom.scene);getState().room.revision=conflictRoom.revision;getState().room.scene=clone(base);conflictRoom=null;}if(!base)return;onScene(bindDraft(getState().room,clone(base)));history=[];future=[];selected=null;dirty=false;saveError='';tool='select';copyTemplate=null;onSelect(null);update();mode();}
 async function saveLegacyScene(){
  flushFields();
  if(saveInProgress()||!dirty||!permission()||getState().room?.id!==roomId||getState().user?.id!==actorId||!same(admission,admissionIdentity()))return;const denied=changeError(base,getScene());if(denied){saveError=denied;toast(denied);update({inspect:false});return;}try{validateStarts(getScene());validateTerrain(getScene().terrain,getScene().bounds);for(const item of getScene().objects){if(item.type==='image'){validateImageInstance(item);if(!resolvedImage(getScene(),item))throw new Error('This image version is unavailable. Refresh Custom images before saving.');}if(item.type==='composition'){validateCompositionObject(item);if(!resolvedComposition(getScene(),item))throw Error('This furniture revision is unavailable. Open it in the workshop before saving.');}if(item.actions!==undefined)validateActions(item.actions,{scope:'item'});}for(const area of getScene().areas||[])if(area.actions!==undefined)validateActions(area.actions);}catch(error){saveError=error.message;toast(error.message);update({inspect:false});return;}cancelGesture();const savingRoom=roomId,revision=getState().room.revision,scene=clone(getScene()),epoch=++saveEpoch;const operation=pendingSave={epoch,roomEpoch,roomId:savingRoom,actorId,admission:admissionIdentity(),initialMetadata:roomMetadata(getState().room),metadata:{},committed:conflictRoom?clone(conflictRoom):null};saving=true;saveError='';update();
  try{
   const result=await api('/api/rooms/'+savingRoom+'/scene',{method:'PUT',body:{revision,scene,...(policy().saveMetadata?.()||{})},deferRoomPreparation:true});
   if(!saveCurrent(operation))return;
   const receipt=result.room||result;if(receipt.id!==undefined&&receipt.id!==savingRoom)throw new Error('The save response belongs to another room. Your draft is unchanged.');
   if(!Number.isSafeInteger(receipt.revision)||receipt.revision<=revision)throw new Error('The save response has an invalid revision. Your draft is unchanged.');
   const accepted={...receipt,id:savingRoom,scene:receipt.scene||scene},committed=newerScene(accepted,operation.committed);
   const room=reconciledRoom({...accepted,revision:committed.revision,scene:committed.scene},operation);
   bindServerRoom(room);acceptRoomMetadata(room);getState().room.revision=room.revision;base=clone(room.scene);getState().room.scene=clone(base);onScene(bindDraft(getState().room,clone(base)));conflictRoom=null;dirty=false;
   if(Number(room.revision)>Number(receipt.revision)){history=[];future=[];}if(!itemById(selected))selected=null;
   forceLegacy=false;onSelect(selected);toast('Room saved · your place is ready');
  }
  catch(e){
   if(!saveCurrent(operation))return;
   const remote=e.data?.room,code=e.code||e.data?.code||e.data?.error?.code||e.data?.error;
   const newerRoom=remote?.id===savingRoom&&remote.scene&&Number(remote.revision)>Number(revision);
   const committed=newerScene(operation.committed,newerRoom?remote:null);
   if(committed&&Number(committed.revision)>Number(revision)){
    conflictRoom=bindServerRoom(reconciledRoom(committed,operation));acceptRoomMetadata(conflictRoom);
   }
   if(collaborative()&&committed?.scene){reconcileRoom(reconciledRoom(committed,operation));}
   if(e.status===409&&(code==='REVISION_CONFLICT'||newerRoom)){saveError='Someone saved a newer version. Your draft is still here.';toast('A newer room version was saved. Export your draft or load the server version.');}
   else{saveError=e.message||'Save failed. Your edits are still here.';toast(saveError);}
  }
  finally{if(pendingSave===operation){const current=saveCurrent(operation);retireSave();if(current){update();refreshPreview();}}}
 }
 function receiveSceneLegacy(room){
  saveInProgress();
  if(room.id!==roomId||room.id!==getState().room?.id||actorId!==getState().user?.id||!same(admission,admissionIdentity()))return;
  flushFields();
  if(pendingSave){pendingSave.committed=newerScene(pendingSave.committed,room);Object.assign(pendingSave.metadata,roomMetadata(room));}
  bindServerRoom(room);acceptRoomMetadata(room);
  // Keep the newest recovery geometry even when a later metadata-only event
  // repeats an older scene revision. Loading recovery must retain live authority.
  if(conflictRoom)conflictRoom=reconciledRoom({...newerScene(conflictRoom,room),...roomMetadata(getState().room)});
  if(saving||Number(room.revision)<=Number(getState().room.revision)){update({inspect:false});refreshPreview();return;}
  if(dirty){conflictRoom=reconciledRoom({...newerScene(conflictRoom,room),...roomMetadata(getState().room)});update({inspect:false});refreshPreview();return;}
  cancelGesture();base=clone(room.scene);history=[];future=[];getState().room.revision=room.revision;getState().room.scene=clone(base);onScene(bindDraft(getState().room,clone(base)));if(!itemById(selected))selected=null;onSelect(selected);update();
 }
 // Validate final combined geometry after every rebase. Never move a peer item
 // or shift a draft automatically to make an invalid merge appear successful.
 function geometryProblem(scene,server=base){
  try{bindDraft(getState().room,scene);bindDraft(getState().room,server);return (!same(server,scene)&&changeError(server,scene,server))||reconciliationGeometryProblem(server,scene);}catch(error){return error.message;}
 }

 function reconcileRoom(room,{reference=review?.reference||base,choices={},acknowledged=false}={}){
  room=reconciledRoom(room);bindServerRoom(room);acceptRoomMetadata(room);bindDraft(getState().room,reference);
  const result=reconcileScenes({base:reference,mine:getScene(),server:room.scene,choices,validate:geometryProblem,forceReview:forceLegacy,version:operationVersion()||1});
  if(result.conflicts.length){conflictRoom=room;review={reference:clone(reference),server:room,conflicts:result.conflicts};reviewChoices={};saveError='';if(reviewOpen)renderReview();update({inspect:false});return false;}
  const undoResult=rebaseHistory(history,{base:reference,server:room.scene,validate:geometryProblem,version:operationVersion()||1}),redoResult=rebaseHistory(future,{base:reference,server:room.scene,validate:geometryProblem,version:operationVersion()||1});
  if(undoResult.invalidated||redoResult.invalidated){history=[];future=[];historyNotice='Earlier undo history was cleared because shared changes made it unsafe.';}else{history=undoResult.entries;future=redoResult.entries;}
  const wasReviewOpen=reviewOpen;closeReview({restore:false});base=jsonSnapshot(room.scene);getState().room.revision=room.revision;getState().room.scene=jsonSnapshot(base);onScene(bindDraft(getState().room,result.scene));conflictRoom=null;review=null;reviewChoices={};saveError='';if(acknowledged&&same(result.scene,room.scene))forceLegacy=false;if(!itemById(selected))selected=null;onSelect(selected);update();if(wasReviewOpen)save.focus();refreshPreview();return true;
 }
 function receiveScene(room){
  if(!collaborative())return receiveSceneLegacy(room);
  saveInProgress();if(room.id!==roomId||room.id!==getState().room?.id||actorId!==getState().user?.id||!same(admission,admissionIdentity()))return;
  flushFields();bindServerRoom(room);acceptRoomMetadata(room);
  const inFlight=pendingSave||retrySave;if(inFlight){inFlight.committed=newerScene(inFlight.committed,room);Object.assign(inFlight.metadata,roomMetadata(room));update({inspect:false});refreshPreview();return;}
  if(Number(room.revision)<=Number(getState().room.revision)){update({inspect:false});refreshPreview();return;}
  if(conflictRoom&&Number(room.revision)<=Number(conflictRoom.revision)){conflictRoom=reconciledRoom({...conflictRoom,...roomMetadata(getState().room)});if(review)review.server=conflictRoom;update({inspect:false});return;}
  cancelGesture();reconcileRoom(room);
 }
 function setReviewInert(value){for(const child of root.children)if(child!==reviewSheet)child.inert=value;}
 function openReview({record=true}={}){if(!review||retrySave||saving||!enabled||root.hidden||!permission()||getState().room?.id!==roomId||getState().user?.id!==actorId||!same(admission,admissionIdentity()))return false;if(reviewOpen)return true;bindDraft(getState().room,review.reference);const refreshed=reconcileScenes({base:review.reference,mine:getScene(),server:review.server.scene,validate:geometryProblem,forceReview:forceLegacy,version:operationVersion()||1});if(!refreshed.conflicts.length&&!review.serverOnly){reconcileRoom(review.server,{reference:review.reference});return false;}if(refreshed.conflicts.length)review.conflicts=refreshed.conflicts;reviewChoices={};cancelGesture();reviewOpen=true;reviewSheet.hidden=false;setReviewInert(true);renderReview();reviewSheet.querySelector('button')?.focus();window.dispatchEvent(new CustomEvent('editor-review',{detail:{open:true,record}}));return true;}
 function closeReview({record=true,restore=true}={}){const wasOpen=reviewOpen;reviewOpen=false;reviewSheet.hidden=true;setReviewInert(false);if(wasOpen){window.dispatchEvent(new CustomEvent('editor-review',{detail:{open:false,record}}));if(restore)reviewBtn.hidden?save.focus():reviewBtn.focus();}}
 function renderReview(){
  if(!review)return;reviewBody.replaceChildren();reviewBody.append(el('p','','Choose which changes to keep. Nothing is saved until you review and press Save.'));
  for(const conflict of review.conflicts){const row=el('fieldset','builder-conflict-row');row.append(el('legend','',conflictLabel(conflict)),el('p','',conflict.reason));const values=el('div','builder-conflict-values');for(const [label,value]of [['Base',conflict.base],['Mine',conflict.mine],['Server',conflict.server]]){const column=el('div');column.append(el('strong','',label),el('p','',conflictValueLabel(value,conflict.kind,conflict.field)));const details=el('details');details.append(el('summary','','Exact value'),el('pre','',JSON.stringify(value,null,2)));column.append(details);values.append(column);}row.append(values);
   const choices=el('div','builder-conflict-choices');for(const choice of ['mine','server']){const label=el('label'),radio=el('input');radio.type='radio';radio.name='resolve-'+conflict.key;radio.value=choice;radio.checked=reviewChoices[conflict.key]===choice;radio.onchange=()=>{reviewChoices[conflict.key]=choice;applyReview.disabled=review.conflicts.some(c=>!reviewChoices[c.key])||!permission();};label.append(radio,el('span','',conflict.kind==='geometry'?(choice==='mine'?'Keep my changes (must fit safely)':'Use server (discard my draft changes)'):conflict.kind==='dependencies'?(choice==='mine'?'Keep my changes with this shared space':'Use server (discard my draft changes)'):conflict.kind==='context'?(choice==='mine'?'Keep my settings and recheck on this room':'Use server settings, keep independent item edits'):choice==='mine'?'Keep mine':'Use server'));choices.append(label);}row.append(choices);reviewBody.append(row);
  }applyReview.disabled=review.conflicts.some(c=>!reviewChoices[c.key])||!permission();
 }
 function resolveReview(){
  if(!review||!permission()||getState().room?.id!==roomId||getState().user?.id!==actorId||!same(admission,admissionIdentity()))return;
  const current=review,choices={...reviewChoices};bindDraft(getState().room,current.reference);const result=reconcileScenes({base:current.reference,mine:getScene(),server:current.server.scene,choices,validate:geometryProblem,forceReview:forceLegacy,version:operationVersion()||1});
  if(result.conflicts.length){toast(result.conflicts[0].reason+' Keep editing or choose the server version.');return;}
  closeReview({restore:false});history=[];future=[];historyNotice='Undo history starts with this reviewed draft.';
  base=jsonSnapshot(current.server.scene);getState().room.revision=current.server.revision;getState().room.scene=jsonSnapshot(base);onScene(bindDraft(getState().room,result.scene));forceLegacy=!same(result.scene,current.server.scene)&&(forceLegacy||result.legacy);conflictRoom=null;review=null;reviewChoices={};saveError='';if(!itemById(selected))selected=null;onSelect(selected);update();save.focus();toast(result.legacy?'Reviewed room settings are ready. Save applies this whole-room version.':'Reviewed changes are ready. Save sends a new batch against the current room.');
 }
 async function saveScene(){
  flushFields();if(review){openReview();return;}if(retrySave)return saveOperations();
  if(!collaborative()||forceLegacy||!base||sceneChanges(base,getScene(),{version:operationVersion()||1}).legacy||!sceneChanges(base,getScene(),{version:operationVersion()||1}).changes.length)return saveLegacyScene();
  return saveOperations();
 }
 async function saveOperations(){
  if(saveInProgress()||(!dirty&&!retrySave)||!permission()||getState().room?.id!==roomId||getState().user?.id!==actorId||!same(admission,admissionIdentity()))return;
  let operation=retrySave;
  if(!operation){
   const denied=changeError(base,getScene())||geometryProblem(getScene());if(denied){saveError=denied;toast(denied);update({inspect:false});return;}
   operation={epoch:++saveEpoch,roomEpoch,roomId,actorId,admission:admissionIdentity(),initialMetadata:roomMetadata(getState().room),metadata:{},committed:null,scene:jsonSnapshot(getScene()),baseScene:jsonSnapshot(base),revision:getState().room.revision,kind:'operations',version:operationVersion()};
  }
  retrySave=null;pendingSave=operation;saving=true;cancelGesture();saveError='';update();
  try{
   if(!operation.body){bindDraft(getState().room,operation.baseScene);bindDraft(getState().room,operation.scene);const [admissionId,admissionEpoch,admissionRevision]=operation.admission;operation.body=await createSceneOperationRequest({version:operation.version,base:operation.baseScene,mine:operation.scene,baseRevision:operation.revision,operationId:uid(),admission:{admissionId,admissionEpoch,admissionRevision},...(policy().saveMetadata?.()||{})});operation.requestHash=await sceneRequestHash(operation.roomId,operation.body);}
   if(!saveCurrent(operation))return;
   operation.sent=true;const result=await api('/api/rooms/'+operation.roomId+'/scene/operations',{method:'POST',body:operation.body,deferRoomPreparation:true});if(!saveCurrent(operation))return;
   const receipt=result.receipt,room=result.room;
   if(!receipt||receipt.version!==operation.body.version||receipt.operationId!==operation.body.operationId||receipt.actorId!==operation.actorId||receipt.roomId!==operation.roomId||!Number.isSafeInteger(receipt.appliedRevision)||receipt.appliedRevision<=operation.revision||receipt.requestHash!==operation.requestHash||room?.id!==operation.roomId||!Number.isSafeInteger(room.revision)||room.revision<receipt.appliedRevision||!room.scene)throw Error('The save receipt could not be verified. Retry this same save to check its result.');
   const committed=reconciledRoom(newerScene(room,operation.committed),operation);pendingSave=null;saving=false;
   reconcileRoom(committed,{reference:operation.scene,acknowledged:true});toast('Room saved · independent shared changes kept');
  }catch(error){
   if(!saveCurrent(operation))return;
   // An older endpoint rejecting a retry cannot establish the first attempt's outcome.
   const errorCode=error.code||error.data?.code||error.data?.error?.code,unsupportedRetry=operation.unknownOutcome&&([404,405].includes(error.status)||error.status===400&&errorCode==='INVALID_SCENE_OPERATIONS');
   if(operation.sent&&(!error.status||error.status>=500||unsupportedRetry)){operation.unknownOutcome=true;retrySave=operation;saveError=error.message||'The save result is unknown. Retry this same save.';toast(saveError);}
   else{const remote=error.data?.room,code=error.code||error.data?.code||error.data?.error?.code,committed=newerScene(operation.committed,remote?.id===operation.roomId?remote:null);pendingSave=null;saving=false;
    if(committed?.scene&&Number(committed.revision)>=Number(operation.revision))reconcileRoom(reconciledRoom(committed,operation));
    if(!review&&error.status===409&&code==='SCENE_OPERATION_CONFLICT'){conflictRoom=committed||{...getState().room,scene:jsonSnapshot(base)};review={reference:jsonSnapshot(base),server:conflictRoom,serverOnly:true,conflicts:[{kind:'geometry',key:'geometry',base:jsonSnapshot(base),mine:jsonSnapshot(getScene()),server:jsonSnapshot(conflictRoom.scene),reason:error.message||'These changes cannot fit in the current room.'}]};}
    saveError=error.message||'Save failed. Your draft is safe.';toast(saveError);
   }
  }finally{if(pendingSave===operation){pendingSave=null;saving=false;}if(saveCurrent(operation)){update();refreshPreview();}}
 }
 function exportScene(){const data=JSON.stringify({format:'universe-room',version:1,name:getState().room.name,scene:getScene()},null,2);const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));const a=el('a');a.href=url;a.download=getState().room.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 async function importScene(file){if(!file||saving||!roomPermission())return;const targetRoom=roomId;try{if(file.size>512000)throw new Error('Room file is too large (500 KB maximum)');const doc=JSON.parse(await file.text()),s=doc.scene||doc;if(roomId!==targetRoom||saving)return;if(['imageDefinitions','compositionDefinitions'].some(key=>Object.prototype.hasOwnProperty.call(s,key)))throw new Error('Image definitions belong to the room library, not imported scene metadata');if(!Array.isArray(s.objects)||!Array.isArray(s.areas)||!s.bounds||!s.spawn||s.objects.length>2000||s.areas.length>100)throw new Error('This is not a supported room file');if(![s.bounds.width,s.bounds.depth,s.spawn.x,s.spawn.z].every(Number.isFinite)||s.bounds.width<8||s.bounds.depth<8||s.bounds.width>200||s.bounds.depth>200)throw new Error('Invalid room bounds or arrival point');validateStarts(s);validateTerrain(s.terrain,s.bounds);const ids=new Set();for(const o of [...s.objects,...s.areas]){if(typeof o.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(o.id)||ids.has(o.id)||!Number.isFinite(o.x)||!Number.isFinite(o.z))throw new Error('Invalid or duplicate item in room file');ids.add(o.id);}bindImageDefinitions(s,imageDefinitions(getScene()),roomId);bindCompositionDefinitions(s,compositionDefinitions(getScene()),roomId);for(const o of s.objects){if(o.type==='image'){validateImageInstance(o);if(!resolvedImage(s,o))throw new Error('Import references an unavailable image version in this room');}else if(o.type==='composition'){validateCompositionObject(o);if(!resolvedComposition(s,o))throw Error('Import references unavailable furniture in this room');}else if(!CATALOG[o.type])throw new Error('Invalid object type in room file');}for(const item of [...s.objects,...s.areas]){const result=validatePlacement(s,item,{excludeId:item.id});if(!result.valid)throw new Error((item.name||item.type||'Area')+': '+result.reason);}if(!canStand(s,s.spawn.x,s.spawn.z,.4))throw new Error('The arrival point needs a clear place to stand');cancelGesture();selected=null;forceLegacy=true;mutate(next=>{for(const k of Object.keys(next))delete next[k];Object.assign(next,clone(s));});toast('Imported into your draft. Save to apply.');}catch(e){toast(e.message);}finally{importInput.value='';}}
 function focusCanvas(){document.getElementById('game')?.focus({preventScroll:true});}
 function areaAt(point){if(!point)return null;return [...(getScene()?.areas||[])].reverse().find(a=>contains(a,point.x,point.z));}
 function ensureKeyboardPoint(){
  if(lastHit?.point)return;const p=getState().position||getScene().spawn;if(strokeTool()){lastHit={point:{x:Math.floor(p.x)+2,z:Math.floor(p.z)-2}};return;}
  for(let r=2;r<10;r+=1)for(const [dx,dz]of [[1,0],[-1,0],[0,-1],[0,1],[1,-1],[-1,1]]){const point=snapPoint({x:p.x+dx*r,z:p.z+dz*r},snap),item=candidateFor(point);if(item&&validatePlacement(getScene(),item,{excludeId:null,position:p}).valid){lastHit={point};return;}}
  lastHit={point:{x:0,z:0}};
 }
 function keyboardStep(key,resize=false){
  if(strokeTool()){if(!roomPermission()||saving)return;if(gesture)cancelGesture();ensureKeyboardPoint();const delta=screenGridStep(key,getCameraAngle(),1);if(resize){if(tool==='wall-draw')terrainSize.width=Math.max(1,Math.min(200,terrainSize.width+(['arrowup','arrowright'].includes(key)?1:-1)));else terrainSize={width:Math.max(1,Math.min(200,terrainSize.width+delta.x)),depth:Math.max(1,Math.min(200,terrainSize.depth+delta.z))};}else lastHit={point:{x:lastHit.point.x+delta.x,z:lastHit.point.z+delta.z}};refreshPreview();focusCanvas();return;}
  const item=activeImage(),step=placementStep(item),delta=screenGridStep(key,getCameraAngle(),step||.1);
  if(tool==='select'&&selected){const item=itemById(selected);if(!item)return;if(resize&&!item.type){const changed=mutate(s=>{const area=s.areas.find(o=>o.id===selected),minimum=area.start?1:.5;area.width=Math.max(minimum,area.width+delta.x);area.depth=Math.max(minimum,area.depth+delta.z);},{validateId:selected});if(changed)message('Area resized · Undo with Ctrl/Cmd+Z');return;}const changed=mutate(s=>{const o=[...s.objects,...s.areas].find(o=>o.id===selected);Object.assign(o,positionFor({x:o.x+delta.x,z:o.z+delta.z},o));},{validateId:selected});if(changed)message(step?'Item nudged on the '+snap+'m grid · Undo with Ctrl/Cmd+Z':'Floating image nudged by 0.1m · Use Free position / Grid to snap');return;}
  if(!CATALOG[tool]&&tool!=='area'&&tool!=='image'&&tool!=='composition'&&!copyTemplate){message('Choose furniture first, or use [ / ] to select an item');return;}
  ensureKeyboardPoint();lastHit={point:positionFor({x:lastHit.point.x+delta.x,z:lastHit.point.z+delta.z},item)};refreshPreview();focusCanvas();
 }
 function cycleSelection(direction){const items=[...(getScene()?.objects||[]),...(getScene()?.areas||[])];if(!items.length){message('This room is empty. Open Furniture to add something');return;}const index=items.findIndex(i=>i.id===selected),next=(index+direction+items.length)%items.length;select(items[next].id);focusCanvas();message('Selected '+items[next].name+' · Arrows move · R rotates · D duplicates');}
 function key(e){
  if(reviewOpen){if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();e.stopPropagation();toast('Choose which changes to keep, then use reviewed choices before saving.');if(applyReview.disabled)reviewBody.querySelector('input')?.focus();else applyReview.focus();}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeReview();}else if(e.key==='Tab'){const controls=[...reviewSheet.querySelectorAll('button,input,summary')].filter(x=>!x.disabled&&x.getClientRects().length),first=controls[0],last=controls.at(-1);if(!controls.includes(document.activeElement)){e.preventDefault();(e.shiftKey?last:first)?.focus();}else if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}return;}
  if(!active()||getState().room?.id!==roomId||e.isComposing||e.keyCode===229||e.altKey)return;const k=e.key.toLowerCase();
  if((e.ctrlKey||e.metaKey)&&k==='s'){e.preventDefault();saveScene();return;}
  if(typing(e.target)||typing(document.activeElement))return;
  if((e.ctrlKey||e.metaKey)&&k==='z'){e.preventDefault();e.shiftKey?redoScene():undoScene();return;}
  if((e.ctrlKey||e.metaKey)&&k==='s'){e.preventDefault();saveScene();return;}
  if(e.ctrlKey||e.metaKey)return;
  if(k==='escape'){e.preventDefault();if(moreOpen){moreOpen=false;update({inspect:false});moreBtn.focus();return;}if(gesture){cancelGesture();message('Build preview cancelled');}else if(tool!=='select'||selected||copyTemplate||roomSettings){setTool('select');}else{cancelGesture();onClose?.();}return;}
  // Focused controls own their keys. Canvas shortcuts resume after returning to the world.
  if(control(e.target)||control(document.activeElement))return;
  if(e.repeat)return;
  if(['arrowup','arrowdown','arrowleft','arrowright'].includes(k)){e.preventDefault();keyboardStep(k,e.shiftKey);return;}
  if(k===' '||k==='enter'){if(e.target?.closest?.('button,a,summary,[role="button"]'))return;if(strokeTool()){e.preventDefault();ensureKeyboardPoint();const rect=terrainTool()?currentTerrainRect():null,wall=tool==='wall-draw'?wallCandidate():null;if(gesture)cancelGesture();if(rect)commitTerrain(rect);else commitWall(wall);}else if(CATALOG[tool]||tool==='area'||tool==='image'||tool==='composition'||copyTemplate){e.preventDefault();ensureKeyboardPoint();pointerDown(lastHit,{button:0});pointerUp(lastHit,{button:0});}return;}
  if(k==='delete'||k==='backspace'){if(selected){e.preventDefault();remove();}return;}
  if(k==='r'){e.preventDefault();rotate();}else if(k==='v'){e.preventDefault();setTool('select');}else if(k==='x'){e.preventDefault();setTool('erase');}else if(k==='d'&&selected){e.preventDefault();duplicate();}else if(k==='['||k===']'){e.preventDefault();cycleSelection(k===']'?1:-1);}
 }
 const cancelPointer=event=>{if(gesture&&(event.pointerId===undefined||gesture.pointerId===event.pointerId))cancelGesture();};
 // Follow the actual available HUD lane, including an open side window. Moving
 // the existing controls preserves their handlers, permission state and focus.
 const syncLayout=()=>{
  const r=root.getBoundingClientRect();if(!r.width||!r.height)return;
  const nextShort=r.height<540,nextCompact=r.width<760||nextShort;
  if(nextCompact===compact&&nextShort===shortLayout&&root.dataset.compact)return;
  const focus=root.contains(document.activeElement)?document.activeElement:null;
  compact=nextCompact;shortLayout=nextShort;root.dataset.compact=String(compact);root.dataset.short=String(shortLayout);
  if(compact){belt.replaceChildren(selectBtn,addBtn,terrainBtn,rotateBtn,moreBtn);moreBody.append(...extraTools,help);header.insertBefore(save,close);}
  else{belt.replaceChildren(...fullTools);root.append(help);moreOpen=false;}
  update({inspect:false});
  if(focus?.isConnected&&focus.getClientRects().length)focus.focus({preventScroll:true});
 };
 const layoutObserver=new ResizeObserver(syncLayout);layoutObserver.observe(root);syncLayout();
 window.addEventListener('keydown',key);window.addEventListener('blur',cancelGesture);window.addEventListener('pointercancel',cancelPointer);
 return {resumeAdmission,isReviewOpen:()=>reviewOpen,openReview,closeReview,attachRoom,setBuild,setTool,setImageAsset,setCompositionAsset,replaceCompositionAsset,undo:undoScene,redo:redoScene,rotate,duplicate,remove,pick,pointerDown,pointerMove,pointerUp,cancelGesture,select,save:saveScene,receiveScene,isDirty:()=>dirty,isSaving:saveInProgress,getSelected:()=>selected,getTool:()=>tool,getInteractionState:()=>({tool,selected,snap:strokeTool()?1:placementStep(activeImage()),rotation,dragging:!!gesture?.dragged,preview:preview?clone(preview):null,undo:history.length,redo:future.length,dirty,saving:saveInProgress()}),revert,exportScene,destroy(){closeReview({record:false,restore:false});retireSave();roomEpoch++;layoutObserver.disconnect();for(const picker of destinationPickers)picker.destroy();destinationPickers=[];cancelGesture();window.removeEventListener('keydown',key);window.removeEventListener('blur',cancelGesture);window.removeEventListener('pointercancel',cancelPointer);window.removeEventListener('pointerdown',rememberTouchOrigin,true);root.removeEventListener('click',guardTouchClick,true);root.removeEventListener('pointerdown',inspectorPointerDown,true);window.removeEventListener('pointerup',inspectorPointerEnd);window.removeEventListener('pointercancel',inspectorPointerEnd);}};
}
