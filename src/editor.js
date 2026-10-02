import {roomAllows} from './permissions.js';
import {attachRoomFile,listRoomFiles,FILE_ACCEPT} from './files.js';
import {CATALOG,clone,canStand,contains} from './worlds.js';
import {snapPoint,validatePlacement} from './editor-geometry.js';
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const uid=()=>crypto.randomUUID();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const touchUI=()=>window.matchMedia?.('(pointer:coarse)').matches;
const typing=target=>!!target?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]');

export function mountEditor({root,getState,onScene,onSelect,api,toast,onClose,onGhost=()=>{},onModeChange=()=>{},getCameraAngle=()=>Math.PI/4,isBlocked=()=>false}){
 let tool='select',selected=null,history=[],future=[],dirty=false,saving=false,base=null,roomId=null,conflictRoom=null;
 let enabled=false,gesture=null,preview=null,lastHit=null,rotation=0,snap=1,copyTemplate=null,roomSettings=false,trayOpen=true;
 let inspectorKey='',lastMessage='',saveError='',saveEpoch=0,validationCache=null;
 root.classList.add('editor-workbench');
 const getScene=()=>getState().scene;
 const permission=()=>roomAllows(getState().room,'canEditScene');
 const itemById=id=>[...(getScene()?.objects||[]),...(getScene()?.areas||[])].find(i=>i.id===id);
 const active=()=>enabled&&!root.hidden&&!!getScene()&&!isBlocked();
 function button(label,action,title=label){const b=el('button','small-btn',label);b.type='button';b.title=title;b.onclick=action;return b;}
 const header=el('div','builder-heading');const title=el('div','builder-title');title.append(el('span','builder-eyebrow','MAKE THIS PLACE YOURS'),el('strong','','Build mode'));
 const close=button('Done',()=>{cancelGesture();onClose?.();},'Leave build mode');close.ariaLabel='Close editor';close.classList.add('builder-done');header.append(title,close);
 const status=el('div','editor-status','All changes saved');status.setAttribute('aria-live','polite');header.append(status);root.append(header);
 const belt=el('div','builder-toolbelt');belt.setAttribute('role','toolbar');belt.setAttribute('aria-label','Build tools');root.append(belt);
 const selectBtn=button('↖ Select',()=>setTool('select'),'Select and drag an item (V)');
 const eraseBtn=button('⌫ Erase',()=>setTool('erase'),'Click an item to erase it (X)');
 const addBtn=button('＋ Furniture',()=>{trayOpen=!trayOpen;update({inspect:false});},'Open the furniture tray');
 const areaBtn=button('▱ Area',()=>setTool('area'),'Place an interactive area');
 const rotateBtn=button('↻ Rotate',()=>rotate(),'Rotate 90° (R)');
 const duplicateBtn=button('⧉',()=>duplicate(),'Duplicate selected item (D)');duplicateBtn.ariaLabel='Duplicate selected item';
 const undo=button('↶',()=>undoScene(),'Undo last change (Ctrl/Cmd+Z)');undo.ariaLabel='Undo';
 const redo=button('↷',()=>redoScene(),'Redo (Ctrl/Cmd+Shift+Z)');redo.ariaLabel='Redo';
 const snapBtn=button('Grid 1m',()=>{snap=snap===1?.5:1;gesture=null;refreshPreview();update({inspect:false});},'Toggle 1 metre / half-metre snapping');
 const settingsBtn=button('⚙ Room',()=>{roomSettings=!roomSettings;update({inspect:true});},'Room settings, areas and room files');
 const save=button('Save room',()=>saveScene(),'Save room (Ctrl/Cmd+S)');save.classList.add('primary');
 belt.append(selectBtn,eraseBtn,addBtn,areaBtn,rotateBtn,duplicateBtn,undo,redo,snapBtn,settingsBtn,save);
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
 const hint=el('div','builder-hint');hint.setAttribute('role','status');const hintText=el('span','','Choose furniture, then click the ground');const hintCoords=el('small','','');hint.append(hintText,hintCoords);root.append(hint);
 const recovery=el('div','builder-recovery');recovery.hidden=true;const recoveryText=el('span');const exportBtn=button('Export my draft',()=>exportScene());const discard=button('Revert',()=>revert());recovery.append(recoveryText,exportBtn,discard);root.append(recovery);
 const help=el('details','builder-keyhelp');const helpTitle=el('summary','','?  Keyboard & controls');help.append(helpTitle);const helpCopy=el('div','','V select · X erase · R rotate · D duplicate\nArrow keys move a preview or nudge selection\nSpace places · [ / ] select previous / next item\nDelete erases · Esc cancels, then leaves Build\nCtrl/Cmd+Z undo · Shift+Z redo · Ctrl/Cmd+S save\nTab reaches every tool · Enter activates buttons\nRight-drag / two fingers orbit · Wheel zooms');help.append(helpCopy);root.append(help);
 const importInput=el('input');importInput.type='file';importInput.accept='.json,application/json';importInput.hidden=true;importInput.onchange=()=>importScene(importInput.files[0]);root.append(importInput);

 function mode(){onModeChange({tool,selected,dragging:!!gesture?.dragged,snap,enabled});}
 function emitGhost(value){preview=value;onGhost(value);if(value){hint.classList.toggle('invalid',!value.valid);hintCoords.textContent=`${value.x.toFixed(1)}, ${value.z.toFixed(1)} · ${value.rotation||0}°`;message(value.valid?(value.kind==='move'?'Release to move · Esc cancels':value.kind==='duplicate'?(touchUI()?'Tap to place a copy · Select cancels':'Click to place a copy · Esc cancels'):(touchUI()?'Tap to place · Rotate below · Select finishes':'Click to place · R rotates · Esc selects')):value.reason);}else{hint.classList.remove('invalid');hintCoords.textContent='';message(tool==='select'?(touchUI()?'Tap to select · Drag to move · Two fingers to look around':'Click to select · Drag to move · Right-drag to look around'):tool==='erase'?'Click an item to erase it · Undo is always available':'Move onto the room to preview · R rotates');}}
 function message(text){if(lastMessage===text)return;lastMessage=text;hintText.textContent=text;}
 function candidateFor(point){const p=snapPoint(point,snap);if(!p)return null;if(copyTemplate)return {...clone(copyTemplate),...p,rotation};if(tool==='area')return {type:'area',name:'New area',...p,width:4,depth:4,rotation:0,action:'welcome',message:'Welcome to this area'};if(CATALOG[tool])return {type:tool,name:CATALOG[tool].name,...p,rotation};return null;}
 function ghostFor(item,kind='place',excludeId){const scene=getScene(),position=getState().position,key=JSON.stringify([item.type,item.x,item.z,item.width,item.depth,item.rotation,excludeId,position?.x,position?.z]);let validity;if(validationCache?.scene===scene&&validationCache.key===key)validity=validationCache.result;else{validity=validatePlacement(scene,item,{excludeId,position});validationCache={scene,key,result:validity};}return {...item,type:item.type||'area',...validity,kind,snap,...(excludeId?{sourceId:excludeId}:{})};}
 function refreshPreview(){if(!active()||saving){emitGhost(null);return;}const item=candidateFor(lastHit?.point);emitGhost(item?ghostFor(item,copyTemplate?'duplicate':tool==='area'?'area':'place',null):null);}
 function attachRoom(){const state=getState();enabled=!root.hidden;if(roomId!==state.room?.id){roomId=state.room?.id;base=clone(state.scene);history=[];future=[];selected=null;dirty=false;tool='select';conflictRoom=null;saveError='';gesture=null;copyTemplate=null;roomSettings=false;lastHit=null;inspectorKey='';emitGhost(null);}update();mode();}
 function setBuild(value){enabled=!!value;if(!value)cancelGesture();else update();mode();}
 function record(before,selection=selected){history.push({scene:before,selected:selection});if(history.length>80)history.shift();future=[];dirty=!same(getScene(),base);saveError='';onSelect(selected);update();}
 function mutate(fn,{validateId=null,inspect=true,previousSelection=selected}={}){
  if(saving)return false;if(!permission()){toast('Only room owners and editors can build');return false;}
  const before=clone(getScene()),next=clone(before),previous=previousSelection;fn(next);
  if(validateId){const v=[...next.objects,...next.areas].find(o=>o.id===validateId);const check=v&&validatePlacement(next,v,{excludeId:v.id,position:getState().position});if(check&&!check.valid){toast(check.reason);message(check.reason);update();return false;}}
  if(same(before,next))return false;onScene(next);record(before,previous);if(!inspect)update({inspect:false});return true;
 }
 function setTool(value){cancelGesture();tool=value;copyTemplate=null;selected=null;onSelect(null);roomSettings=false;if(value==='select'||value==='erase')trayOpen=false;else trayOpen=false;if(CATALOG[value]||value==='area')ensureKeyboardPoint();refreshPreview();update();mode();focusCanvas();}
 function renderSearch(){const query=search.value.trim().toLowerCase();results.replaceChildren();for(const b of catalog.querySelectorAll('button'))b.hidden=query&&!((CATALOG[b.dataset.tool].name+' '+b.dataset.tool).toLowerCase().includes(query));if(!query)return;const matches=[...(getScene()?.objects||[]),...(getScene()?.areas||[])].filter(o=>(o.name+' '+(o.type||'area')+' '+(o.text||'')).toLowerCase().includes(query)).slice(0,8);if(matches.length)results.append(el('small','','ALREADY IN THIS ROOM'));for(const item of matches)results.append(button(item.name,()=>{select(item.id);trayOpen=false;update({inspect:false});}));}
 function update({inspect=true}={}){
  const canEdit=permission();dirty=!!base&&!same(getScene(),base);renderSearch();
  status.textContent=conflictRoom?'A newer room version needs your attention':saving?'Saving to this room…':saveError?'Save failed · your draft is safe':dirty?'Unsaved changes · save when ready':'All changes saved';
  status.classList.toggle('dirty',dirty);status.classList.toggle('error',!!saveError||!!conflictRoom);
  undo.disabled=!history.length||saving||!canEdit;redo.disabled=!future.length||saving||!canEdit;save.disabled=!dirty||saving||!canEdit;save.textContent=saving?'Saving…':'Save room';
  discard.textContent=conflictRoom?'Load server version':'Revert to saved';discard.disabled=!dirty||saving;
  recovery.hidden=!conflictRoom&&!saveError;recoveryText.textContent=conflictRoom?'Your edits are safe here. Export them before loading the newer room.':saveError;
  for(const b of [selectBtn,eraseBtn,addBtn,areaBtn,rotateBtn,duplicateBtn,snapBtn])b.disabled=saving||!canEdit;
  rotateBtn.disabled=saving||(!selected&&!CATALOG[tool]&&!copyTemplate);duplicateBtn.disabled=saving||!selected;
  for(const b of catalog.querySelectorAll('button')){b.classList.toggle('active',b.dataset.tool===tool);b.disabled=saving||!canEdit;}
  selectBtn.classList.toggle('active',tool==='select');eraseBtn.classList.toggle('active',tool==='erase');areaBtn.classList.toggle('active',tool==='area');addBtn.classList.toggle('active',trayOpen||!!CATALOG[tool]);settingsBtn.classList.toggle('active',roomSettings);snapBtn.textContent='Grid '+snap+'m';
  tray.hidden=!trayOpen;inspectorShell.hidden=!selected&&!roomSettings;inspectorTitle.textContent=selected?(itemById(selected)?.name||'Item details'):'Room settings';
  if(inspect)renderInspectorStable();for(const input of inspector.querySelectorAll('input,select,textarea,button'))input.disabled=saving||!canEdit;
  root.dataset.tool=tool;root.dataset.dragging=String(!!gesture?.dragged);root.dataset.dirty=String(dirty);
  window.dispatchEvent(new CustomEvent('editor-status',{detail:{dirty,saving}}));
 }
 function renderInspectorStable(){
  const oldScroll=inspector.scrollTop,focus=document.activeElement,focusLabel=inspector.contains(focus)?focus.closest('label')?.querySelector('span')?.textContent:null,focusButton=inspector.contains(focus)&&focus.tagName==='BUTTON'?{label:focus.getAttribute('aria-label'),text:focus.textContent,title:focus.title}:null,start=focus?.selectionStart,end=focus?.selectionEnd;
  const key=selected||'room';if(key!==inspectorKey)inspector.scrollTop=0;const detailsOpen=[...inspector.querySelectorAll('details')].filter(d=>d.open).map(d=>d.dataset.section);renderInspector();
  if(key===inspectorKey){inspector.scrollTop=oldScroll;for(const d of inspector.querySelectorAll('details'))if(detailsOpen.includes(d.dataset.section))d.open=true;if(focusLabel){const field=[...inspector.querySelectorAll('label')].find(l=>l.querySelector('span')?.textContent===focusLabel)?.querySelector('input,textarea,select');if(field){field.focus({preventScroll:true});try{field.setSelectionRange(start,end);}catch{}}}else if(focusButton){const b=[...inspector.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===focusButton.label&&b.textContent===focusButton.text&&b.title===focusButton.title);b?.focus({preventScroll:true});}}inspectorKey=key;
 }
 function field(label,value,onChange,{type='text',min,max,step,options}={}){const wrap=el('label','field');wrap.append(el('span','',label));const input=el(options?'select':type==='textarea'?'textarea':'input');if(!options){if(type!=='textarea')input.type=type;input.value=value??'';if(min!=null)input.min=min;if(max!=null)input.max=max;if(step!=null)input.step=step;}else{for(const [val,name]of options){const op=el('option','',name);op.value=val;input.append(op);}input.value=value??'';}input.onchange=()=>onChange(type==='number'?Number(input.value):input.value);wrap.append(input);return wrap;}
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
  const selectedId=v.id;const patch=(k,val)=>mutate(s=>{const item=[...s.objects,...s.areas].find(i=>i.id===selectedId);if(item)item[k]=val;},{validateId:['x','z','rotation','width','depth'].includes(k)?selectedId:null});
  const summary=el('p','panel-hint',a?'An invisible zone with real room behavior. Drag it to move.':'Drag this item in the room. R rotates it.');inspector.append(summary);
  const actions=el('div','editor-actions');if(o)actions.append(button('↻ Rotate',()=>rotate()));actions.append(button('Duplicate',()=>duplicate()),button('Delete',()=>remove()));inspector.append(actions);
  inspector.append(field('Name',v.name,val=>patch('name',val)));
  const row=el('div','field-row');row.append(field('X',v.x,val=>patch('x',val),{type:'number',step:snap}),field('Z',v.z,val=>patch('z',val),{type:'number',step:snap}));inspector.append(row);
  if(a){
   const size=el('div','field-row');size.append(field('Width',a.width,val=>patch('width',val),{type:'number',min:.5,max:scene.bounds.width,step:.5}),field('Depth',a.depth,val=>patch('depth',val),{type:'number',min:.5,max:scene.bounds.depth,step:.5}));inspector.append(size);
   inspector.append(field('On entry',a.action,val=>patch('action',val),{options:[['welcome','Show a message'],['silent','Quiet / no proximity'],['meeting','Meeting room'],['stage','Broadcast stage'],['audience','Broadcast audience'],['teleport','Teleport to room'],['link','Open a website prompt']]}));
   if(['meeting','stage','audience'].includes(a.action))inspector.append(field('Shared meeting name',a.meetingName||a.name,val=>patch('meetingName',val)));
   if(a.action==='teleport')inspector.append(field('Destination room ID',a.target||'',val=>patch('target',val)));
   if(a.action==='link')inspector.append(field('Website URL',a.url||'',val=>patch('url',val),{type:'url'}));
   inspector.append(field('Area message',a.message||'',val=>patch('message',val),{type:'textarea'}));
   const extra=details('More actions · '+(a.actions?.length||0),'area-actions');
   extra.append(el('p','panel-hint','Combine messages, links, travel and opt-in sounds in one area.'));
   for(const action of a.actions||[]){const card=el('div','action-card');card.append(el('strong','',action.type==='link'?'Website / document':action.type==='audio'?'Room sound':action.type==='teleport'?'Room travel':'Message'));const change=(key,value)=>mutate(s=>{const item=s.areas.find(v=>v.id===selectedId)?.actions?.find(v=>v.id===action.id);if(item)item[key]=value;});
    if(action.type==='message')card.append(field('Text',action.message||'',v=>change('message',v),{type:'textarea'}));
    if(action.type==='link'||action.type==='audio')card.append(field('URL',action.url||'',v=>change('url',v),{type:'url'}));
    if(action.type==='link')card.append(field('Link label',action.label||'',v=>change('label',v)));
    if(action.type==='audio'){card.append(field('Volume',action.volume??.5,v=>change('volume',v),{type:'number',min:0,max:1,step:.1}));card.append(field('Playback',String(action.loop??true),v=>change('loop',v==='true'),{options:[['true','Loop in this area'],['false','Play once']]}));}
    if(action.type==='teleport')card.append(field('Destination room ID',action.target||'',v=>change('target',v)));
    card.append(button('Remove action',()=>mutate(s=>{const area=s.areas.find(v=>v.id===selectedId);area.actions=area.actions.filter(v=>v.id!==action.id);})));extra.append(card);
   }
   const add=el('div','editor-actions');for(const[type,label]of [['message','+ Message'],['link','+ Link'],['audio','+ Sound'],['teleport','+ Travel']])add.append(button(label,()=>mutate(s=>{const area=s.areas.find(v=>v.id===selectedId);area.actions??=[];if(area.actions.length>=20){toast('An area can hold up to 20 additional actions');return;}const item={id:uid(),type};if(type==='message')item.message='A new message';if(type==='link'){item.url='https://example.com';item.label='Open website';}if(type==='audio'){item.url='/assets/chime.wav';item.volume=.5;item.loop=true;}if(type==='teleport')item.target='commons';area.actions.push(item);})));extra.append(add);inspector.append(extra);
  }else{
   inspector.append(field('Rotation',v.rotation||0,val=>patch('rotation',Number(val)),{options:[[0,'0°'],[90,'90°'],[180,'180°'],[270,'270°']]}));
   const appearance=details('Appearance & interaction','item-properties');appearance.append(field('Color',v.color||CATALOG[v.type].color,val=>patch('color',val),{type:'color'}),field('Description',v.text||'',val=>patch('text',val),{type:'textarea'}),field('Open URL on interaction',v.url||'',val=>patch('url',val),{type:'url'}));if(v.type==='portal')appearance.append(field('Destination room ID',v.target||'',val=>patch('target',val)));inspector.append(appearance);
   renderDocuments(v,inspector);
  }
 }
 function renderDocuments(v,parent){
  const docs=details(v.document?'Document · '+v.document.name:'Attach a room document','documents');const uploadInput=el('input');uploadInput.type='file';uploadInput.accept=FILE_ACCEPT;uploadInput.hidden=true;const capturedRoom=roomId,capturedItem=v.id;
  const upload=button('Upload a document',()=>uploadInput.click());uploadInput.onchange=async()=>{const file=uploadInput.files[0];if(!file)return;upload.disabled=true;upload.textContent='Uploading…';try{const saved=await attachRoomFile({roomId:capturedRoom,file});if(roomId!==capturedRoom||!getScene().objects.some(o=>o.id===capturedItem)){toast('Uploaded to the original room. Select an item there to attach it.');return;}if(saving){toast('Document uploaded. Choose it from the list after saving.');return;}mutate(s=>{const item=s.objects.find(o=>o.id===capturedItem);item.url=saved.url;item.name=saved.name.slice(0,120);item.document={id:saved.id,name:saved.name,size:saved.size,contentType:saved.contentType};});toast('Document attached to this draft. Save the room to keep it.');}catch(e){toast(e.message);}finally{upload.disabled=false;upload.textContent='Upload a document';uploadInput.value='';}};docs.append(upload,uploadInput);
  const savedList=el('select');savedList.ariaLabel='Saved room document';const placeholder=el('option','','Choose an uploaded document');placeholder.value='';savedList.append(placeholder);docs.append(savedList);
  savedList.onchange=()=>{const item=savedList._files?.find(f=>f.id===savedList.value);if(!item)return;mutate(s=>{const o=s.objects.find(o=>o.id===capturedItem);if(o){o.url=item.url;o.name=item.name.slice(0,120);o.document={id:item.id,name:item.name,size:item.size,contentType:item.contentType};}});};
  let loaded=false;docs.addEventListener('toggle',()=>{if(!docs.open||loaded)return;loaded=true;listRoomFiles(capturedRoom).then(result=>{if(!docs.isConnected)return;savedList._files=result.files||[];for(const file of savedList._files){const option=el('option','',file.name);option.value=file.id;savedList.append(option);}}).catch(()=>{loaded=false;});});if(v.document)docs.append(el('p','panel-hint','Attached: '+v.document.name+' · '+Math.ceil(v.document.size/1024)+' KB'));parent.append(docs);
 }
 function select(id){cancelGesture();tool='select';copyTemplate=null;selected=itemById(id)?id:null;roomSettings=false;onSelect(selected);update();mode();}
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
    const p=snapPoint({x:gesture.item.x+hit.point.x-gesture.point.x,z:gesture.item.z+hit.point.z-gesture.point.z},snap);
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
  if(copyTemplate||CATALOG[tool]){rotation=(rotation+90)%360;refreshPreview();return;}
  if(gesture?.dragged&&gesture.item?.type){gesture.item.rotation=((gesture.item.rotation||0)+90)%360;if(preview)emitGhost(ghostFor({...gesture.item,x:preview.x,z:preview.z},'move',gesture.item.id));return;}
  const item=itemById(selected);if(!item?.type)return;mutate(s=>{const o=s.objects.find(o=>o.id===selected);o.rotation=((o.rotation||0)+90)%360;},{validateId:selected});
 }
 function duplicate(){const item=itemById(selected);if(!item||saving)return;cancelGesture();copyTemplate=clone(item);delete copyTemplate.id;lastHit={point:{x:item.x,z:item.z}};rotation=item.rotation||0;tool='duplicate';trayOpen=false;selected=null;onSelect(null);ensureKeyboardPoint();refreshPreview();focusCanvas();message('Move your copy into place · Click to keep it · Esc cancels');update();mode();}
 function remove(id=selected){if(!id||saving||!itemById(id))return false;cancelGesture();const prev=selected;selected=null;const ok=mutate(s=>{s.objects=s.objects.filter(o=>o.id!==id);s.areas=s.areas.filter(o=>o.id!==id);},{previousSelection:prev});if(!ok)selected=prev;onSelect(selected);update();return ok;}
 function undoScene(){if(!history.length||saving||!permission())return;cancelGesture();future.push({scene:clone(getScene()),selected});const prev=history.pop();onScene(clone(prev.scene));selected=prev.selected&&itemById(prev.selected)?prev.selected:null;tool='select';copyTemplate=null;saveError='';onSelect(selected);update();mode();}
 function redoScene(){if(!future.length||saving||!permission())return;cancelGesture();history.push({scene:clone(getScene()),selected});const next=future.pop();onScene(clone(next.scene));selected=next.selected&&itemById(next.selected)?next.selected:null;tool='select';copyTemplate=null;saveError='';onSelect(selected);update();mode();}
 function revert(){if(saving)return;cancelGesture();if(conflictRoom){base=clone(conflictRoom.scene);getState().room.revision=conflictRoom.revision;getState().room.scene=clone(conflictRoom.scene);conflictRoom=null;}if(!base)return;onScene(clone(base));history=[];future=[];selected=null;dirty=false;saveError='';tool='select';copyTemplate=null;onSelect(null);update();mode();}
 async function saveScene(){
  if(saving||!dirty||!permission())return;cancelGesture();const savingRoom=roomId,revision=getState().room.revision,scene=clone(getScene()),epoch=++saveEpoch;saving=true;saveError='';update();
  try{const result=await api('/api/rooms/'+savingRoom+'/scene',{method:'PUT',body:{revision,scene}});if(roomId!==savingRoom||epoch!==saveEpoch)return;const room=result.room||result;getState().room.revision=room.revision;base=clone(room.scene||scene);getState().room.scene=clone(base);onScene(clone(base));conflictRoom=null;dirty=false;onSelect(selected);toast('Room saved · your place is ready');}
  catch(e){if(roomId!==savingRoom||epoch!==saveEpoch)return;if(e.status===409){conflictRoom=e.data?.room||conflictRoom;saveError='Someone saved a newer version. Your draft is still here.';toast('A newer room version was saved. Export your draft or load the server version.');}else{saveError=e.message||'Save failed. Your edits are still here.';toast(saveError);}}
  finally{if(epoch===saveEpoch){saving=false;update();refreshPreview();}}
 }
 function receiveScene(room){if(room.id!==roomId||saving||Number(room.revision)<=Number(getState().room.revision))return;if(dirty){conflictRoom=clone(room);update({inspect:false});return;}cancelGesture();base=clone(room.scene);history=[];future=[];getState().room.revision=room.revision;getState().room.scene=clone(room.scene);onScene(clone(room.scene));if(!itemById(selected))selected=null;onSelect(selected);update();}
 function exportScene(){const data=JSON.stringify({format:'universe-room',version:1,name:getState().room.name,scene:getScene()},null,2);const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));const a=el('a');a.href=url;a.download=getState().room.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 async function importScene(file){if(!file||saving||!permission())return;const targetRoom=roomId;try{if(file.size>512000)throw new Error('Room file is too large (500 KB maximum)');const doc=JSON.parse(await file.text()),s=doc.scene||doc;if(roomId!==targetRoom||saving)return;if(!Array.isArray(s.objects)||!Array.isArray(s.areas)||!s.bounds||!s.spawn||s.objects.length>2000||s.areas.length>100)throw new Error('This is not a supported room file');if(![s.bounds.width,s.bounds.depth,s.spawn.x,s.spawn.z].every(Number.isFinite)||s.bounds.width<8||s.bounds.depth<8||s.bounds.width>200||s.bounds.depth>200)throw new Error('Invalid room bounds or arrival point');const ids=new Set();for(const o of [...s.objects,...s.areas]){if(typeof o.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(o.id)||ids.has(o.id)||!Number.isFinite(o.x)||!Number.isFinite(o.z))throw new Error('Invalid or duplicate item in room file');ids.add(o.id);}for(const o of s.objects)if(!CATALOG[o.type])throw new Error('Invalid object type in room file');for(const item of [...s.objects,...s.areas]){const result=validatePlacement(s,item,{excludeId:item.id});if(!result.valid)throw new Error((item.name||item.type||'Area')+': '+result.reason);}if(!canStand(s,s.spawn.x,s.spawn.z,.4))throw new Error('The arrival point needs a clear place to stand');cancelGesture();selected=null;mutate(next=>{for(const k of Object.keys(next))delete next[k];Object.assign(next,clone(s));});toast('Imported into your draft. Save to apply.');}catch(e){toast(e.message);}finally{importInput.value='';}}
 function focusCanvas(){document.getElementById('game')?.focus({preventScroll:true});}
 function areaAt(point){if(!point)return null;return [...(getScene()?.areas||[])].reverse().find(a=>contains(a,point.x,point.z));}
 function ensureKeyboardPoint(){
  if(lastHit?.point)return;const p=getState().position||getScene().spawn;
  for(let r=2;r<10;r+=1)for(const [dx,dz]of [[1,0],[-1,0],[0,-1],[0,1],[1,-1],[-1,1]]){const point=snapPoint({x:p.x+dx*r,z:p.z+dz*r},snap),item=candidateFor(point);if(item&&validatePlacement(getScene(),item,{excludeId:null,position:p}).valid){lastHit={point};return;}}
  lastHit={point:{x:0,z:0}};
 }
 function keyboardStep(key){
  const angle=getCameraAngle();const right={x:Math.sin(angle),z:-Math.cos(angle)},forward={x:-Math.cos(angle),z:-Math.sin(angle)};
  const dir=key==='arrowright'?right:key==='arrowleft'?{x:-right.x,z:-right.z}:key==='arrowup'?forward:{x:-forward.x,z:-forward.z};
  const delta={x:Math.round(dir.x)*snap,z:Math.round(dir.z)*snap};
  if(tool==='select'&&selected){const item=itemById(selected);if(!item)return;mutate(s=>{const o=[...s.objects,...s.areas].find(o=>o.id===selected);Object.assign(o,snapPoint({x:o.x+delta.x,z:o.z+delta.z},snap));},{validateId:selected});message('Item nudged on the '+snap+'m grid · Undo with Ctrl/Cmd+Z');return;}
  if(!CATALOG[tool]&&tool!=='area'&&!copyTemplate){message('Choose furniture first, or use [ / ] to select an item');return;}
  ensureKeyboardPoint();lastHit={point:snapPoint({x:lastHit.point.x+delta.x,z:lastHit.point.z+delta.z},snap)};refreshPreview();focusCanvas();
 }
 function cycleSelection(direction){const items=[...(getScene()?.objects||[]),...(getScene()?.areas||[])];if(!items.length){message('This room is empty. Open Furniture to add something');return;}const index=items.findIndex(i=>i.id===selected),next=(index+direction+items.length)%items.length;select(items[next].id);focusCanvas();message('Selected '+items[next].name+' · Arrows move · R rotates · D duplicates');}
 function key(e){
  if(!active()||e.isComposing||e.keyCode===229||typing(e.target)||typing(document.activeElement)||e.altKey)return;const k=e.key.toLowerCase();
  if((e.ctrlKey||e.metaKey)&&k==='z'){e.preventDefault();e.shiftKey?redoScene():undoScene();return;}
  if((e.ctrlKey||e.metaKey)&&k==='s'){e.preventDefault();saveScene();return;}
  if(e.ctrlKey||e.metaKey)return;
  if(k==='escape'){e.preventDefault();if(gesture){cancelGesture();message('Move cancelled');}else if(tool!=='select'||selected||copyTemplate||roomSettings){setTool('select');}else{cancelGesture();onClose?.();}return;}
  if(e.repeat)return;
  if(['arrowup','arrowdown','arrowleft','arrowright'].includes(k)){e.preventDefault();keyboardStep(k);return;}
  if(k===' '){if(e.target?.closest?.('button,a,summary,[role="button"]'))return;if(CATALOG[tool]||tool==='area'||copyTemplate){e.preventDefault();ensureKeyboardPoint();pointerDown(lastHit,{button:0});pointerUp(lastHit,{button:0});}return;}
  if(k==='delete'||k==='backspace'){if(selected){e.preventDefault();remove();}return;}
  if(k==='r'){e.preventDefault();rotate();}else if(k==='v'){e.preventDefault();setTool('select');}else if(k==='x'){e.preventDefault();setTool('erase');}else if(k==='d'&&selected){e.preventDefault();duplicate();}else if(k==='['||k===']'){e.preventDefault();cycleSelection(k===']'?1:-1);}
 }
 window.addEventListener('keydown',key);
 return {attachRoom,setBuild,setTool,undo:undoScene,redo:redoScene,rotate,duplicate,remove,pick,pointerDown,pointerMove,pointerUp,cancelGesture,select,save:saveScene,receiveScene,isDirty:()=>dirty,isSaving:()=>saving,getSelected:()=>selected,getTool:()=>tool,getInteractionState:()=>({tool,selected,snap,rotation,dragging:!!gesture?.dragged,preview:preview?clone(preview):null,undo:history.length,redo:future.length,dirty,saving}),revert,exportScene,destroy(){cancelGesture();window.removeEventListener('keydown',key);}};
}
