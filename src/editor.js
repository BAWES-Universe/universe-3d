import {roomAllows} from './permissions.js';
import {attachRoomFile,listRoomFiles,FILE_ACCEPT} from './files.js';
import {CATALOG,clone,canStand,contains} from './worlds.js';
import {snapPoint,validatePlacement,screenGridStep} from './editor-geometry.js';
import {imageDefinitions,resolvedImage,bindImageDefinitions} from './image-asset-context.js';
import {validateAssetReference,validateImageInstance,IMAGE_PIXELS_PER_METRE} from './image-asset-schema.js';
import {ACTION_TYPES,MAX_ACTIONS,createAction,itemActions,materializeItemActions,actionName,validateActions,safeActionUrl} from './action-schema.js';
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const uid=()=>crypto.randomUUID();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const touchUI=()=>window.matchMedia?.('(pointer:coarse)').matches;
const typing=target=>!!target?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]');

export function mountEditor({root,getState,onScene,onSelect,api,toast,onClose,onGhost=()=>{},onModeChange=()=>{},getCameraAngle=()=>Math.PI/4,isBlocked=()=>false,editPolicy=()=>null,onManagePersonalArea=()=>{},onOpenImageLibrary=()=>{}}){
 let tool='select',selected=null,history=[],future=[],dirty=false,saving=false,base=null,roomId=null,conflictRoom=null;
 let enabled=false,gesture=null,preview=null,lastHit=null,rotation=0,snap=1,imageSnap=false,imageAsset=null,copyTemplate=null,roomSettings=false,trayOpen=true;
 let inspectorKey='',lastMessage='',saveError='',saveEpoch=0,roomEpoch=0,flushing=false,pointerControl=null,deferredInspector=false,validationCache=null;
 root.classList.add('editor-workbench');
 const getScene=()=>getState().scene;
 const roomPermission=()=>roomAllows(getState().room,'canEditScene');
 const policy=()=>editPolicy(getState())||{};
 const permission=()=>roomPermission()||policy().canEdit===true;
 const itemPermission=item=>roomPermission()||!!item&&policy().canEditItem?.(item)===true;
 const changeError=(before,next)=>{if(roomPermission())return null;const scoped=policy();return scoped.canEdit===true&&typeof scoped.validateChange==='function'?scoped.validateChange(before,next):'Only room owners and editors can change room settings';};
 const itemById=id=>[...(getScene()?.objects||[]),...(getScene()?.areas||[])].find(i=>i.id===id);
 const active=()=>enabled&&!root.hidden&&!!getScene()&&!isBlocked();
 function button(label,action,title=label){const b=el('button','small-btn',label);b.type='button';b.title=title;b.onclick=event=>{pointerControl=null;flushFields();action(event);if(deferredInspector){deferredInspector=false;update();}};return b;}
 const header=el('div','builder-heading');const title=el('div','builder-title');title.append(el('span','builder-eyebrow','MAKE THIS PLACE YOURS'),el('strong','','Build mode'));
 const close=button('Done',()=>{cancelGesture();onClose?.();},'Leave build mode');close.ariaLabel='Close editor';close.classList.add('builder-done');header.append(title,close);
 const status=el('div','editor-status','All changes saved');status.setAttribute('aria-live','polite');header.append(status);root.append(header);
 const belt=el('div','builder-toolbelt');belt.setAttribute('role','toolbar');belt.setAttribute('aria-label','Build tools');root.append(belt);
 const selectBtn=button('↖ Select',()=>setTool('select'),'Select and drag an item (V)');
 const eraseBtn=button('⌫ Erase',()=>setTool('erase'),'Click an item to erase it (X)');
 const addBtn=button('＋ Furniture',()=>{trayOpen=!trayOpen;update({inspect:false});},'Open the furniture tray');
 const customBtn=button('Custom images',()=>{cancelGesture();onOpenImageLibrary();},'Open the room’s custom image library');customBtn.classList.add('builder-custom-images');
 const areaBtn=button('▱ Area',()=>setTool('area'),'Place an interactive area');
 const rotateBtn=button('↻ Rotate',()=>rotate(),'Rotate 90° (R)');
 const duplicateBtn=button('⧉',()=>duplicate(),'Duplicate selected item (D)');duplicateBtn.ariaLabel='Duplicate selected item';
 const undo=button('↶',()=>undoScene(),'Undo last change (Ctrl/Cmd+Z)');undo.ariaLabel='Undo';
 const redo=button('↷',()=>redoScene(),'Redo (Ctrl/Cmd+Shift+Z)');redo.ariaLabel='Redo';
 const snapBtn=button('Grid 1m',()=>{if(floatingImage(activeImage())){if(!imageSnap){imageSnap=true;snap=1;}else if(snap===1)snap=.5;else imageSnap=false;}else snap=snap===1?.5:1;gesture=null;refreshPreview();update({inspect:false});mode();},'Toggle 1 metre / half-metre snapping');
 const settingsBtn=button('⚙ Room',()=>{roomSettings=!roomSettings;update({inspect:true});},'Room settings, areas and room files');
 const save=button('Save room',()=>saveScene(),'Save room (Ctrl/Cmd+S)');save.classList.add('primary');
 belt.append(selectBtn,eraseBtn,addBtn,customBtn,areaBtn,rotateBtn,duplicateBtn,undo,redo,snapBtn,settingsBtn,save);
 const tray=el('section','builder-tray');tray.ariaLabel='Furniture tray';const trayTop=el('div','builder-tray-top');trayTop.append(el('strong','','A few things to make it yours'));
 const trayClose=button('×',()=>{trayOpen=false;update({inspect:false});},'Close furniture tray');trayClose.ariaLabel='Close furniture tray';trayTop.append(trayClose);tray.append(trayTop);
 const search=el('input','builder-search');search.type='search';search.placeholder='Find furniture or a placed item…';search.ariaLabel='Search room items';tray.append(search);
 const results=el('div','editor-search-results');tray.append(results);const catalog=el('div','catalog');tray.append(catalog);root.append(tray);
 const shortNames={table:'Table',chair:'Chair',sofa:'Sofa',plant:'Plant',tree:'Tree',wall:'Wall',lamp:'Lantern',screen:'Screen',podium:'Podium',portal:'Portal',rug:'Rug',board:'Board',bench:'Bench',rock:'Stone'};
 for(const [type,def]of Object.entries(CATALOG)){
  const b=button('',()=>setTool(type),def.name+' · '+def.width+' × '+def.depth+' m');b.dataset.tool=type;b.ariaLabel='Place '+def.name;
  const art=el('span','furniture-icon furniture-'+type,def.icon);art.style.setProperty('--item-color',def.color);art.setAttribute('aria-hidden','true');b.append(art,el('span','furniture-name',shortNames[type]||def.name));catalog.append(b);
 }
 search.oninput=renderSearch;
 const inspectorShell=el('section','builder-inspector');const inspectorHeader=el('div','builder-inspector-heading');const inspectorTitle=el('strong','','Item details');const inspectorClose=button('×',()=>{roomSettings=false;if(selected){selected=null;onSelect(null);}update();},'Close item details');inspectorClose.ariaLabel='Close item details';inspectorHeader.append(inspectorTitle,inspectorClose);inspectorShell.append(inspectorHeader);
 const inspector=el('div','inspector');inspectorShell.append(inspector);root.append(inspectorShell);
 const inspectorPointerDown=event=>{const target=event.target?.closest?.('button');pointerControl=target&&inspector.contains(target)?target:null;};
 const inspectorPointerEnd=()=>{const target=pointerControl;if(!target)return;setTimeout(()=>{if(pointerControl!==target)return;pointerControl=null;if(deferredInspector){deferredInspector=false;update();}},0);};
 root.addEventListener('pointerdown',inspectorPointerDown,true);window.addEventListener('pointerup',inspectorPointerEnd);window.addEventListener('pointercancel',inspectorPointerEnd);
 const hint=el('div','builder-hint');hint.setAttribute('role','status');const hintText=el('span','','Choose furniture, then click the ground');const hintCoords=el('small','','');hint.append(hintText,hintCoords);root.append(hint);
 const recovery=el('div','builder-recovery');recovery.hidden=true;const recoveryText=el('span');const exportBtn=button('Export my draft',()=>exportScene());const discard=button('Revert',()=>revert());recovery.append(recoveryText,exportBtn,discard);root.append(recovery);
 const help=el('details','builder-keyhelp');const helpTitle=el('summary','','?  Keyboard & controls');help.append(helpTitle);const helpCopy=el('div','','V select · X erase · R rotate · D duplicate\nArrow keys move a preview or nudge selection\nFloating images: Free position / Grid toggles snapping\nSpace places · [ / ] select previous / next item\nDelete erases · Esc cancels, then leaves Build\nCtrl/Cmd+Z undo · Shift+Z redo · Ctrl/Cmd+S save\nTab reaches every tool · Enter activates buttons\nRight-drag / two fingers orbit · Wheel zooms');help.append(helpCopy);root.append(help);
 const importInput=el('input');importInput.type='file';importInput.accept='.json,application/json';importInput.hidden=true;importInput.onchange=()=>importScene(importInput.files[0]);root.append(importInput);

 // Image definitions are a room-scoped read projection, never part of scene JSON.
 function bindServerRoom(room){if(room?.scene)bindImageDefinitions(room.scene,room.imageDefinitions||{},room.id);return room;}
 function bindDraft(room,scene,{preserve=true}={}){
  if(!scene)return scene;
  const previous=preserve?Object.fromEntries(Object.entries(imageDefinitions(scene)).filter(([,entry])=>entry.definition.roomId===room.id)):{};
  bindImageDefinitions(scene,{...previous,...(room.imageDefinitions||{})},room.id);for(const item of scene.objects||[])if(item.type==='image')item.assetRef=validateAssetReference(item.assetRef);return scene;
 }
 function acceptRoomMetadata(room){
  const state=getState();
  for(const k of ['personalAreas','capabilities','role'])if(room[k]!==undefined)state.room[k]=room[k];
  const retained=Object.fromEntries(Object.entries({...state.room.imageDefinitions,...imageDefinitions(state.scene)}).filter(([,entry])=>entry?.definition?.roomId===room.id));
  state.room.imageDefinitions={...retained,...(room.imageDefinitions||{})};
  bindDraft(state.room,state.scene);
 }
 function activeImage(){return gesture?.item||copyTemplate||(tool==='image'&&imageAsset?{type:'image',assetRef:imageAsset}:null)||itemById(selected);}
 function floatingImage(item){return item?.type==='image'&&resolvedImage(getScene(),item)?.version.floating===true;}
 function placementStep(item){return floatingImage(item)&&!imageSnap?0:snap;}
 function positionFor(point,item){if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.z))return null;return placementStep(item)?snapPoint(point,snap):{x:point.x,z:point.z};}
 function imageInstance(item){return {...item,assetRef:validateAssetReference(item.assetRef)};}
 function mode(){onModeChange({tool,selected,dragging:!!gesture?.dragged,snap:placementStep(activeImage()),enabled});}
 function emitGhost(value){preview=value;onGhost(value);if(value){hint.classList.toggle('invalid',!value.valid);hintCoords.textContent=`${value.x.toFixed(1)}, ${value.z.toFixed(1)} · ${value.rotation||0}°`;message(value.valid?(value.kind==='move'?'Release to move · Esc cancels':value.kind==='duplicate'?(touchUI()?'Tap to place a copy · Select cancels':'Click to place a copy · Esc cancels'):(touchUI()?'Tap to place · Rotate below · Select finishes':'Click to place · R rotates · Esc selects')):value.reason);}else{hint.classList.remove('invalid');hintCoords.textContent='';message(tool==='select'?(touchUI()?'Tap to select · Drag to move · Two fingers to look around':'Click to select · Drag to move · Right-drag to look around'):tool==='erase'?'Click an item to erase it · Undo is always available':'Move onto the room to preview · R rotates');}}
 function message(text){if(lastMessage===text)return;lastMessage=text;hintText.textContent=text;}
 function candidateFor(point){
  const p=positionFor(point,activeImage());if(!p)return null;
  if(copyTemplate){const copy={...clone(copyTemplate),...p,rotation};return copy.type==='image'?imageInstance({...copy,id:'image-preview'}):copy;}
  if(tool==='image'&&imageAsset){const entry=resolvedImage(getScene(),{assetRef:imageAsset});return entry?{id:'image-preview',type:'image',assetRef:imageAsset,name:entry.version.name,...p,rotation,actions:[]}:null;}
  if(tool==='area')return {type:'area',name:'New area',...p,width:4,depth:4,rotation:0,action:'welcome',message:'Welcome to this area'};
  if(CATALOG[tool])return {type:tool,name:CATALOG[tool].name,...p,rotation};return null;
 }
 function ghostFor(item,kind='place',excludeId){const scene=getScene(),definitions=imageDefinitions(scene),position=getState().position,key=JSON.stringify([item.type,item.assetRef,item.x,item.z,item.width,item.depth,item.rotation,excludeId,position?.x,position?.z]);let validity;if(validationCache?.scene===scene&&validationCache.definitions===definitions&&validationCache.key===key)validity=validationCache.result;else{validity=validatePlacement(scene,item,{excludeId,position});validationCache={scene,definitions,key,result:validity};}const policyError=!roomPermission()&&policy().validateItem?.(item,excludeId?getScene().objects.find(o=>o.id===excludeId):null);if(policyError)validity={valid:false,reason:policyError};return {...item,type:item.type||'area',...validity,kind,snap:placementStep(item),...(excludeId?{sourceId:excludeId}:{})};}
 function refreshPreview(){if(!active()||saving){emitGhost(null);return;}const item=candidateFor(lastHit?.point);emitGhost(item?ghostFor(item,copyTemplate?'duplicate':tool==='area'?'area':'place',null):null);}
 function attachRoom(){const state=getState();enabled=!root.hidden;const changedRoom=roomId!==state.room?.id;bindServerRoom(state.room);bindDraft(state.room,state.scene,{preserve:!changedRoom});if(changedRoom){roomEpoch++;saveEpoch++;saving=false;pointerControl=null;deferredInspector=false;roomId=state.room?.id;base=clone(state.scene);history=[];future=[];selected=null;dirty=false;tool='select';conflictRoom=null;saveError='';gesture=null;copyTemplate=null;imageAsset=null;imageSnap=false;roomSettings=false;lastHit=null;inspectorKey='';emitGhost(null);}update();mode();}
 function setBuild(value){if(!value)flushFields();enabled=!!value;if(!value)cancelGesture();else update();mode();}
 function record(before,selection=selected){history.push({scene:before,selected:selection});if(history.length>80)history.shift();future=[];dirty=!same(getScene(),base);saveError='';onSelect(selected);update();}
 function mutate(fn,{validateId=null,inspect=true,previousSelection=selected}={}){
  if(saving)return false;if(!permission()){toast('Only room owners and editors can build');return false;}
  const before=clone(getScene()),next=clone(before),previous=previousSelection;fn(next);for(const item of next.objects)if(item.type==='image')item.assetRef=validateAssetReference(item.assetRef);
  const denied=changeError(before,next);if(denied){toast(denied);update();return false;}
  if(validateId){const v=[...next.objects,...next.areas].find(o=>o.id===validateId);const check=v&&validatePlacement(next,v,{excludeId:v.id,position:getState().position});if(check&&!check.valid){toast(check.reason);message(check.reason);update();return false;}}
  if(same(before,next))return false;onScene(next);record(before,previous);if(!inspect)update({inspect:false});return true;
 }
 function setTool(value){if(value==='image'&&!imageAsset){toast('Choose a committed image from Custom images first');return false;}flushFields();if(value==='area'&&!roomPermission()){toast('Only room editors can create areas');return;}cancelGesture();tool=value;copyTemplate=null;selected=null;onSelect(null);roomSettings=false;if(value==='select'||value==='erase')trayOpen=false;else trayOpen=false;if(CATALOG[value]||value==='area'||value==='image')ensureKeyboardPoint();refreshPreview();update();mode();focusCanvas();}
 function setImageAsset(reference){
  if(saving||!permission()||getState().room?.id!==roomId)return false;
  let ref,entry;try{ref=validateAssetReference(reference);entry=resolvedImage(getScene(),{assetRef:ref});}catch{}
  if(!entry||entry.definition.roomId!==roomId){toast('This image version is unavailable. Refresh Custom images and choose it again.');return false;}
  imageAsset=ref;imageSnap=false;rotation=0;setTool('image');return true;
 }
 function renderSearch(){const query=search.value.trim().toLowerCase();results.replaceChildren();for(const b of catalog.querySelectorAll('button'))b.hidden=query&&!((CATALOG[b.dataset.tool].name+' '+b.dataset.tool).toLowerCase().includes(query));if(!query)return;const matches=[...(getScene()?.objects||[]),...(getScene()?.areas||[])].filter(o=>(o.name+' '+(o.type||'area')+' '+(o.text||'')).toLowerCase().includes(query)).slice(0,8);if(matches.length)results.append(el('small','','ALREADY IN THIS ROOM'));for(const item of matches)results.append(button(item.name,()=>{select(item.id);trayOpen=false;update({inspect:false});}));}
 function update({inspect=true}={}){
  if(inspect&&!flushing)flushFields();
  const canEdit=permission();dirty=!!base&&(!same(getScene(),base)||pendingFields());renderSearch();
  status.textContent=conflictRoom?'A newer room version needs your attention':saving?'Saving to this room…':saveError?'Save failed · your draft is safe':dirty?'Unsaved changes · save when ready':'All changes saved';
  status.classList.toggle('dirty',dirty);status.classList.toggle('error',!!saveError||!!conflictRoom);
  undo.disabled=!history.length||saving||!canEdit;redo.disabled=!future.length||saving||!canEdit;save.disabled=!dirty||saving||!canEdit;save.textContent=saving?'Saving…':'Save room';
  discard.textContent=conflictRoom?'Load server version':'Revert to saved';discard.disabled=!dirty||saving;
  recovery.hidden=!conflictRoom&&!saveError;recoveryText.textContent=conflictRoom?'Your edits are safe here. Export them before loading the newer room.':saveError;
  for(const b of [selectBtn,eraseBtn,addBtn,customBtn,areaBtn,rotateBtn,duplicateBtn,snapBtn])b.disabled=saving||!canEdit;
  areaBtn.disabled=saving||!roomPermission();settingsBtn.disabled=saving||!roomPermission();
  rotateBtn.disabled=saving||!permission()||(selected&&!itemPermission(itemById(selected)))||(!selected&&!CATALOG[tool]&&tool!=='image'&&!copyTemplate);duplicateBtn.disabled=saving||!selected||!itemPermission(itemById(selected));
  for(const b of catalog.querySelectorAll('button')){b.classList.toggle('active',b.dataset.tool===tool);b.disabled=saving||!canEdit;}
  selectBtn.classList.toggle('active',tool==='select');eraseBtn.classList.toggle('active',tool==='erase');areaBtn.classList.toggle('active',tool==='area');addBtn.classList.toggle('active',trayOpen||!!CATALOG[tool]);settingsBtn.classList.toggle('active',roomSettings);customBtn.classList.toggle('active',tool==='image');const floating=floatingImage(activeImage());snapBtn.textContent=floating&&!imageSnap?'Free position':'Grid '+snap+'m';snapBtn.title=floating?'Floating image: cycle free position, 1 metre grid, and half-metre grid':'Toggle 1 metre / half-metre snapping';snapBtn.setAttribute('aria-label',floating?'Image placement: '+snapBtn.textContent:snapBtn.textContent);
  tray.hidden=!trayOpen;inspectorShell.hidden=!selected&&!roomSettings;inspectorTitle.textContent=selected?(itemById(selected)?.name||'Item details'):'Room settings';
  if(inspect&&!flushing){if(pointerControl?.isConnected)deferredInspector=true;else renderInspectorStable();}for(const input of inspector.querySelectorAll('input,select,textarea,button'))input.disabled=saving||!canEdit||(!roomPermission()&&(!selected||!getScene().objects.some(o=>o.id===selected)||!itemPermission(itemById(selected))))||input.dataset.unavailable==='true';
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
  inspector.replaceChildren();const scene=getScene();if(!scene)return;
  const o=scene.objects.find(o=>o.id===selected),a=scene.areas.find(a=>a.id===selected),v=o||a;
  if(!v){
   inspector.append(el('p','panel-hint','Build directly in the room. Every change can be undone until you leave.'));
   inspector.append(field('Environment',scene.theme,v=>mutate(s=>s.theme=v),{options:[['garden','Garden'],['studio','Studio'],['assembly','Assembly']]}));
   inspector.append(el('h3','','Interactive areas'));const areas=el('div','area-list');for(const area of scene.areas)areas.append(button('▱ '+area.name,()=>select(area.id)));if(!scene.areas.length)areas.append(el('p','panel-hint','Add an area to give a place a purpose.'));inspector.append(areas);
   inspector.append(button('Set arrival at my position',()=>{const p=getState().position;if(!canStand(scene,p.x,p.z,.75)){toast('Choose an open spot with room for arriving visitors');return;}mutate(s=>s.spawn={x:p.x,z:p.z});}));
   const files=details('Import, export and recovery','room-files');files.append(button('Export room',()=>exportScene()),button('Import JSON',()=>importInput.click()),button('Revert to last save',()=>revert()));inspector.append(files);return;
  }
  const selectedId=v.id;const patch=(k,val)=>mutate(s=>{const item=[...s.objects,...s.areas].find(i=>i.id===selectedId);if(item)item[k]=item.type==='image'&&['x','z'].includes(k)&&placementStep(item)?Math.round(val/snap)*snap:val;},{validateId:['x','z','rotation','width','depth'].includes(k)?selectedId:null});
  const summary=el('p','panel-hint',a?'An invisible zone with real room behavior. Drag it to move.':'Drag this item in the room. R rotates it.');inspector.append(summary);
  const actions=el('div','editor-actions');if(o)actions.append(button('↻ Rotate',()=>rotate()));actions.append(button('Duplicate',()=>duplicate()),button('Delete',()=>remove()));inspector.append(actions);
  inspector.append(field('Name',v.name,val=>patch('name',val)));
  const row=el('div','field-row');row.append(field('X',v.x,val=>patch('x',val),{type:'number',step:placementStep(v)||.1}),field('Z',v.z,val=>patch('z',val),{type:'number',step:placementStep(v)||.1}));inspector.append(row);
  if(a){
   const size=el('div','field-row');size.append(field('Width',a.width,val=>patch('width',val),{type:'number',min:.5,max:scene.bounds.width,step:.5}),field('Depth',a.depth,val=>patch('depth',val),{type:'number',min:.5,max:scene.bounds.depth,step:.5}));inspector.append(size);
   inspector.append(field('On entry',a.action,val=>patch('action',val),{options:[['welcome','Show a message'],['silent','Silent / no calls'],['meeting','Meeting room'],['stage','Broadcast stage'],['audience','Broadcast audience'],['teleport','Teleport to room'],['link','Open a website prompt']]}));
   if(['meeting','stage','audience'].includes(a.action))inspector.append(field('Shared meeting name',a.meetingName||a.name,val=>patch('meetingName',val)));
   if(a.action==='teleport')inspector.append(field('Destination room ID',a.target||'',val=>patch('target',val)));
   if(a.action==='link')inspector.append(field('Website URL',a.url||'',val=>patch('url',val),{type:'url'}));
   inspector.append(field('Area message',a.message||'',val=>patch('message',val),{type:'textarea'}));
   const personal=details('Personal space and ownership','personal-area');
   personal.append(field('Personal space mode',a.personalArea?.mode||'none',mode=>mutate(s=>{const target=s.areas.find(v=>v.id===selectedId);if(mode==='none')delete target.personalArea;else target.personalArea={mode,allowedTags:target.personalArea?.allowedTags||[]};}),{options:[['none','Shared area'],['dynamic','Eligible people can claim'],['static','Assign to an account']]}));
   if(a.personalArea){personal.append(field('Allowed world tags (any match)',(a.personalArea.allowedTags||[]).join(', '),value=>patch('personalArea',{...a.personalArea,allowedTags:[...new Set(value.split(',').map(v=>v.trim()).filter(Boolean))]})));personal.append(el('p','panel-hint','Empty tags allow any signed-in account to claim a dynamic space. Save this room before managing ownership.'),button('Manage ownership',()=>onManagePersonalArea(selectedId)));}
   inspector.append(personal);
   renderActionEditor(v,true,inspector);
  }else{
   inspector.append(field('Rotation',v.rotation||0,val=>patch('rotation',Number(val)),{options:[[0,'0°'],[90,'90°'],[180,'180°'],[270,'270°']]}));
   if(v.type==='image'){
    const asset=resolvedImage(scene,v),summary=el('section','builder-image-summary');summary.ariaLabel='Custom image asset';
    summary.append(el('strong','',asset?.version.name||'Unavailable image version'));
    summary.append(el('span','',asset?'Version '+asset.version.sequence+' · '+asset.version.versionId:'Version '+v.assetRef.versionId));
    if(asset){const version=asset.version;summary.append(el('span','',version.widthPixels+' × '+version.heightPixels+' px · '+version.widthPixels/IMAGE_PIXELS_PER_METRE+' × '+version.heightPixels/IMAGE_PIXELS_PER_METRE+' m'),el('p','panel-hint',version.floating?'Floating image · Free position by default. Use the Free position / Grid tool to snap.':'Collision image · Grid snapping keeps placement aligned with its source collision cells.'));}
    inspector.append(summary);
   }else{
    const appearance=details('Appearance & interaction','item-properties');appearance.append(field('Color',v.color||CATALOG[v.type]?.color||'#ffffff',val=>patch('color',val),{type:'color'}),field('Description',v.text||'',val=>patch('text',val),{type:'textarea'}),field('Open URL on interaction',v.url||'',val=>patchLegacyLink(v,val),{type:'url'}));if(v.type==='portal')appearance.append(field('Destination room ID',v.target||'',val=>patchLegacyTarget(v,val)));inspector.append(appearance);
   }
   renderActionEditor(v,false,inspector);renderDocuments(v,inspector);
  }
 }
 function patchLegacyLink(v,url){mutate(s=>{const item=s.objects.find(i=>i.id===v.id);if(!item)return;if(Array.isArray(item.actions)&&url&&!item.actions.some(a=>a.id==='legacy-url')&&item.actions.length>=MAX_ACTIONS){toast('Remove an action before adding another link');return;}item.url=url;if(Array.isArray(item.actions)){const action=item.actions.find(a=>a.id==='legacy-url');if(action){if(url)action.url=url;else item.actions=item.actions.filter(a=>a.id!=='legacy-url');}else if(url)item.actions.push({...createAction('link','legacy-url'),url});}});}
 function patchLegacyTarget(v,target){mutate(s=>{const item=s.objects.find(i=>i.id===v.id);if(!item)return;if(Array.isArray(item.actions)&&target&&!item.actions.some(a=>a.id==='legacy-target')&&item.actions.length>=MAX_ACTIONS){toast('Remove an action before adding room travel');return;}item.target=target;if(Array.isArray(item.actions)){const action=item.actions.find(a=>a.id==='legacy-target');if(action){if(target)action.target=target;else item.actions=item.actions.filter(a=>a.id!=='legacy-target');}else if(target)item.actions.push({...createAction('teleport','legacy-target'),target});}});}
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
   if(action.type==='teleport')card.append(f('Destination room ID','target'));
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
 function select(id){flushFields();cancelGesture();tool='select';copyTemplate=null;selected=itemById(id)?id:null;roomSettings=false;onSelect(selected);update();mode();}
 function pointerDown(hit,event={}){
  if(!active()||saving||!permission()||(event.button??0)!==0)return false;
  lastHit=hit;const client={x:event.clientX??0,y:event.clientY??0};
  if(tool==='select'){
   // Areas stay selectable through their visible outline/list without masking furniture.
   const id=hit?.id||areaAt(hit?.point)?.id;select(id);const item=itemById(selected);
   gesture={pointerId:event.pointerId,client,point:hit?.point?{...hit.point}:null,item:item?clone(item):null,dragged:false};
  }else gesture={pointerId:event.pointerId,client,point:hit?.point?{...hit.point}:null,dragged:false};
  refreshPreview();return true;
 }
 function pointerMove(hit,event={}){
  if(!active()||saving)return false;lastHit=hit;
  if(gesture&&event.pointerId!==undefined&&gesture.pointerId!==undefined&&gesture.pointerId!==event.pointerId)return false;
  if(gesture){
   const distance=Math.hypot((event.clientX??gesture.client.x)-gesture.client.x,(event.clientY??gesture.client.y)-gesture.client.y);
   if(distance>6)gesture.dragged=true;
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
  if(!active()||!gesture||saving||(event.button??0)!==0)return false;
  if(event.pointerId!==undefined&&gesture.pointerId!==undefined&&gesture.pointerId!==event.pointerId)return false;
  pointerMove(hit,event);const completed=gesture;gesture=null;root.dataset.dragging='false';
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
  if(copyTemplate||CATALOG[tool]||tool==='image'){rotation=(rotation+90)%360;refreshPreview();return;}
  if(gesture?.dragged&&gesture.item?.type){gesture.item.rotation=((gesture.item.rotation||0)+90)%360;if(preview)emitGhost(ghostFor({...gesture.item,x:preview.x,z:preview.z},'move',gesture.item.id));return;}
  const item=itemById(selected);if(!item?.type)return;mutate(s=>{const o=s.objects.find(o=>o.id===selected);o.rotation=((o.rotation||0)+90)%360;},{validateId:selected});
 }
 function duplicate(){flushFields();const item=itemById(selected);if(!item||saving)return;cancelGesture();copyTemplate=item.type==='image'?imageInstance(clone(item)):clone(item);delete copyTemplate.id;lastHit={point:{x:item.x,z:item.z}};rotation=item.rotation||0;tool='duplicate';trayOpen=false;selected=null;onSelect(null);ensureKeyboardPoint();refreshPreview();focusCanvas();message('Move your copy into place · Click to keep it · Esc cancels');update();mode();}
 function remove(id=selected){if(!id||saving||!itemById(id))return false;cancelGesture();const prev=selected;selected=null;const ok=mutate(s=>{s.objects=s.objects.filter(o=>o.id!==id);s.areas=s.areas.filter(o=>o.id!==id);},{previousSelection:prev});if(!ok)selected=prev;onSelect(selected);update();return ok;}
 function undoScene(){if(!history.length||saving||!permission())return;const denied=changeError(getScene(),history.at(-1).scene);if(denied){toast(denied);return;}cancelGesture();future.push({scene:clone(getScene()),selected});const prev=history.pop();onScene(bindDraft(getState().room,clone(prev.scene)));selected=prev.selected&&itemById(prev.selected)?prev.selected:null;tool='select';copyTemplate=null;saveError='';onSelect(selected);update();mode();}
 function redoScene(){if(!future.length||saving||!permission())return;const denied=changeError(getScene(),future.at(-1).scene);if(denied){toast(denied);return;}cancelGesture();history.push({scene:clone(getScene()),selected});const next=future.pop();onScene(bindDraft(getState().room,clone(next.scene)));selected=next.selected&&itemById(next.selected)?next.selected:null;tool='select';copyTemplate=null;saveError='';onSelect(selected);update();mode();}
 function revert(){if(saving)return;cancelGesture();if(conflictRoom){bindServerRoom(conflictRoom);acceptRoomMetadata(conflictRoom);base=clone(conflictRoom.scene);getState().room.revision=conflictRoom.revision;getState().room.scene=clone(base);conflictRoom=null;}if(!base)return;onScene(bindDraft(getState().room,clone(base)));history=[];future=[];selected=null;dirty=false;saveError='';tool='select';copyTemplate=null;onSelect(null);update();mode();}
 async function saveScene(){
  flushFields();
  if(saving||!dirty||!permission())return;const denied=changeError(base,getScene());if(denied){saveError=denied;toast(denied);update({inspect:false});return;}try{for(const item of getScene().objects){if(item.type==='image'){validateImageInstance(item);if(!resolvedImage(getScene(),item))throw new Error('This image version is unavailable. Refresh Custom images before saving.');}if(item.actions!==undefined)validateActions(item.actions,{scope:'item'});}for(const area of getScene().areas||[])if(area.actions!==undefined)validateActions(area.actions);}catch(error){saveError=error.message;toast(error.message);update({inspect:false});return;}cancelGesture();const savingRoom=roomId,revision=getState().room.revision,scene=clone(getScene()),epoch=++saveEpoch;saving=true;saveError='';update();
  try{const result=await api('/api/rooms/'+savingRoom+'/scene',{method:'PUT',body:{revision,scene,...(policy().saveMetadata?.()||{})}});if(roomId!==savingRoom||epoch!==saveEpoch)return;const room=result.room||result;if(room.id!==undefined&&room.id!==savingRoom)throw new Error('The save response belongs to another room. Your draft is unchanged.');bindServerRoom(room);acceptRoomMetadata(room);getState().room.revision=room.revision;base=clone(room.scene||scene);getState().room.scene=clone(base);onScene(bindDraft(getState().room,clone(base)));conflictRoom=null;dirty=false;onSelect(selected);toast('Room saved · your place is ready');}
  catch(e){if(roomId!==savingRoom||epoch!==saveEpoch)return;if(e.status===409){conflictRoom=e.data?.room?bindServerRoom(e.data.room):conflictRoom;saveError='Someone saved a newer version. Your draft is still here.';toast('A newer room version was saved. Export your draft or load the server version.');}else{saveError=e.message||'Save failed. Your edits are still here.';toast(saveError);}}
  finally{if(epoch===saveEpoch){saving=false;update();refreshPreview();}}
 }
 function receiveScene(room){
  if(room.id!==roomId)return;flushFields();bindServerRoom(room);acceptRoomMetadata(room);
  if(saving||Number(room.revision)<=Number(getState().room.revision)){update({inspect:false});refreshPreview();return;}
  if(dirty){conflictRoom=clone(room);update({inspect:false});refreshPreview();return;}
  cancelGesture();base=clone(room.scene);history=[];future=[];getState().room.revision=room.revision;getState().room.scene=clone(base);onScene(bindDraft(getState().room,clone(base)));if(!itemById(selected))selected=null;onSelect(selected);update();
 }
 function exportScene(){const data=JSON.stringify({format:'universe-room',version:1,name:getState().room.name,scene:getScene()},null,2);const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));const a=el('a');a.href=url;a.download=getState().room.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 async function importScene(file){if(!file||saving||!roomPermission())return;const targetRoom=roomId;try{if(file.size>512000)throw new Error('Room file is too large (500 KB maximum)');const doc=JSON.parse(await file.text()),s=doc.scene||doc;if(roomId!==targetRoom||saving)return;if(Object.prototype.hasOwnProperty.call(s,'imageDefinitions'))throw new Error('Image definitions belong to the room library, not imported scene metadata');if(!Array.isArray(s.objects)||!Array.isArray(s.areas)||!s.bounds||!s.spawn||s.objects.length>2000||s.areas.length>100)throw new Error('This is not a supported room file');if(![s.bounds.width,s.bounds.depth,s.spawn.x,s.spawn.z].every(Number.isFinite)||s.bounds.width<8||s.bounds.depth<8||s.bounds.width>200||s.bounds.depth>200)throw new Error('Invalid room bounds or arrival point');const ids=new Set();for(const o of [...s.objects,...s.areas]){if(typeof o.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(o.id)||ids.has(o.id)||!Number.isFinite(o.x)||!Number.isFinite(o.z))throw new Error('Invalid or duplicate item in room file');ids.add(o.id);}bindImageDefinitions(s,imageDefinitions(getScene()),roomId);for(const o of s.objects){if(o.type==='image'){validateImageInstance(o);if(!resolvedImage(s,o))throw new Error('Import references an unavailable image version in this room');}else if(!CATALOG[o.type])throw new Error('Invalid object type in room file');}for(const item of [...s.objects,...s.areas]){const result=validatePlacement(s,item,{excludeId:item.id});if(!result.valid)throw new Error((item.name||item.type||'Area')+': '+result.reason);}if(!canStand(s,s.spawn.x,s.spawn.z,.4))throw new Error('The arrival point needs a clear place to stand');cancelGesture();selected=null;mutate(next=>{for(const k of Object.keys(next))delete next[k];Object.assign(next,clone(s));});toast('Imported into your draft. Save to apply.');}catch(e){toast(e.message);}finally{importInput.value='';}}
 function focusCanvas(){document.getElementById('game')?.focus({preventScroll:true});}
 function areaAt(point){if(!point)return null;return [...(getScene()?.areas||[])].reverse().find(a=>contains(a,point.x,point.z));}
 function ensureKeyboardPoint(){
  if(lastHit?.point)return;const p=getState().position||getScene().spawn;
  for(let r=2;r<10;r+=1)for(const [dx,dz]of [[1,0],[-1,0],[0,-1],[0,1],[1,-1],[-1,1]]){const point=snapPoint({x:p.x+dx*r,z:p.z+dz*r},snap),item=candidateFor(point);if(item&&validatePlacement(getScene(),item,{excludeId:null,position:p}).valid){lastHit={point};return;}}
  lastHit={point:{x:0,z:0}};
 }
 function keyboardStep(key){
  const item=activeImage(),step=placementStep(item),delta=screenGridStep(key,getCameraAngle(),step||.1);
  if(tool==='select'&&selected){const item=itemById(selected);if(!item)return;mutate(s=>{const o=[...s.objects,...s.areas].find(o=>o.id===selected);Object.assign(o,positionFor({x:o.x+delta.x,z:o.z+delta.z},o));},{validateId:selected});message(step?'Item nudged on the '+snap+'m grid · Undo with Ctrl/Cmd+Z':'Floating image nudged by 0.1m · Use Free position / Grid to snap');return;}
  if(!CATALOG[tool]&&tool!=='area'&&tool!=='image'&&!copyTemplate){message('Choose furniture first, or use [ / ] to select an item');return;}
  ensureKeyboardPoint();lastHit={point:positionFor({x:lastHit.point.x+delta.x,z:lastHit.point.z+delta.z},item)};refreshPreview();focusCanvas();
 }
 function cycleSelection(direction){const items=[...(getScene()?.objects||[]),...(getScene()?.areas||[])];if(!items.length){message('This room is empty. Open Furniture to add something');return;}const index=items.findIndex(i=>i.id===selected),next=(index+direction+items.length)%items.length;select(items[next].id);focusCanvas();message('Selected '+items[next].name+' · Arrows move · R rotates · D duplicates');}
 function key(e){
  if(!active()||e.isComposing||e.keyCode===229||e.altKey)return;const k=e.key.toLowerCase();
  if((e.ctrlKey||e.metaKey)&&k==='s'){e.preventDefault();saveScene();return;}
  if(typing(e.target)||typing(document.activeElement))return;
  if((e.ctrlKey||e.metaKey)&&k==='z'){e.preventDefault();e.shiftKey?redoScene():undoScene();return;}
  if((e.ctrlKey||e.metaKey)&&k==='s'){e.preventDefault();saveScene();return;}
  if(e.ctrlKey||e.metaKey)return;
  if(k==='escape'){e.preventDefault();if(gesture){cancelGesture();message('Move cancelled');}else if(tool!=='select'||selected||copyTemplate||roomSettings){setTool('select');}else{cancelGesture();onClose?.();}return;}
  if(e.repeat)return;
  if(['arrowup','arrowdown','arrowleft','arrowright'].includes(k)){e.preventDefault();keyboardStep(k);return;}
  if(k===' '){if(e.target?.closest?.('button,a,summary,[role="button"]'))return;if(CATALOG[tool]||tool==='area'||tool==='image'||copyTemplate){e.preventDefault();ensureKeyboardPoint();pointerDown(lastHit,{button:0});pointerUp(lastHit,{button:0});}return;}
  if(k==='delete'||k==='backspace'){if(selected){e.preventDefault();remove();}return;}
  if(k==='r'){e.preventDefault();rotate();}else if(k==='v'){e.preventDefault();setTool('select');}else if(k==='x'){e.preventDefault();setTool('erase');}else if(k==='d'&&selected){e.preventDefault();duplicate();}else if(k==='['||k===']'){e.preventDefault();cycleSelection(k===']'?1:-1);}
 }
 window.addEventListener('keydown',key);
 return {attachRoom,setBuild,setTool,setImageAsset,undo:undoScene,redo:redoScene,rotate,duplicate,remove,pick,pointerDown,pointerMove,pointerUp,cancelGesture,select,save:saveScene,receiveScene,isDirty:()=>dirty,isSaving:()=>saving,getSelected:()=>selected,getTool:()=>tool,getInteractionState:()=>({tool,selected,snap:placementStep(activeImage()),rotation,dragging:!!gesture?.dragged,preview:preview?clone(preview):null,undo:history.length,redo:future.length,dirty,saving}),revert,exportScene,destroy(){cancelGesture();window.removeEventListener('keydown',key);root.removeEventListener('pointerdown',inspectorPointerDown,true);window.removeEventListener('pointerup',inspectorPointerEnd);window.removeEventListener('pointercancel',inspectorPointerEnd);}};
}
