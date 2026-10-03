import {Engine} from '@babylonjs/core/Engines/engine.js';
import {Scene} from '@babylonjs/core/scene.js';
import {ArcRotateCamera} from '@babylonjs/core/Cameras/arcRotateCamera.js';
import {Vector3} from '@babylonjs/core/Maths/math.vector.js';
import {Color3,Color4} from '@babylonjs/core/Maths/math.color.js';
import {HemisphericLight} from '@babylonjs/core/Lights/hemisphericLight.js';
import {DirectionalLight} from '@babylonjs/core/Lights/directionalLight.js';
import {CreateCylinder} from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial.js';
import {createAvatarRig} from './avatar-rig.js';
import {resizeRenderBuffer,PREVIEW_RENDER_PIXELS} from './render-resolution.js';
import {AVATAR_OPTIONS,AVATAR_PALETTES,AVATAR_PRESETS,appearanceForUser,normalizeAppearance,validateAppearance,appearanceKey} from './avatar-spec.js';
import './avatar-creator.css';

const TAB_FIELDS={
  body:[['height','Height'],['build','Shape'],['skin','Skin tone'],['eyeColor','Eye color']],
  hair:[['hairStyle','Hairstyle'],['hairColor','Hair color']],
  outfit:[['topStyle','Top'],['topColor','Top color'],['bottomStyle','Bottoms'],['bottomColor','Bottoms color'],['shoeStyle','Shoes'],['shoeColor','Shoe color']],
  extras:[['hat','Headwear'],['glasses','Eyewear'],['bag','Bag'],['headphones','Headphones']],
};
const TITLES={body:'Body',hair:'Hair',outfit:'Outfit',extras:'Extras'};
const COLOR_NAMES={skin:['Porcelain peach','Warm sand','Caramel','Chestnut','Rich brown','Deep cocoa','Rose beige','Copper rose'],hairColor:['Midnight','Espresso','Chestnut','Copper','Golden blond','Silver cream','Lavender','Dusty rose','Ocean teal'],eyeColor:['Midnight','Hazel','Forest','Blue','Violet'],topColor:['Universe violet','Plum','Golden yellow','Dusty rose','Sage teal','Denim','Cream','Ink'],bottomColor:['Ink','Slate','Cocoa','Lavender','Sand','Deep teal','Burgundy','Forest'],shoeColor:['Cream','Ink','Violet','Gold','Rose','Teal']};
function el(tag,attrs={},...children){const node=document.createElement(tag);for(const[key,value]of Object.entries(attrs)){if(key==='class')node.className=value;else if(key==='text')node.textContent=value;else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else if(value!==undefined)node.setAttribute(key,String(value));}for(const child of children.flat())if(child)node.append(child);return node;}
const button=(label,action,attrs={})=>el('button',{type:'button',...attrs,onclick:action,text:label});
/** Uses only original, native mesh geometry for its live preview. The pending
 * draft is isolated until Save; Cancel/Escape never writes to the profile. */
export function mountAvatarCreator({root,api,getState,onSaved=()=>{},onOpenChange=()=>{},toast=()=>{}}){
  if(!root)throw new Error('Avatar creator requires a root element');
  root.classList.add('avatar-creator');root.hidden=true;
  let opened=false,destroyed=false,saving=false,draft,baseline,activeTab='body',engine,scene,camera,rig,observer,lastTime=0,animation='idle',returnFocus,commitOverride,generation=0,renderedFrames=0;
  const titleId=`avatar-title-${Math.random().toString(36).slice(2)}`;
  const dialog=el('section',{class:'avatar-dialog',role:'dialog','aria-modal':'true','aria-labelledby':titleId,tabindex:'-1'});
  const title=el('h2',{id:titleId,text:'Your character'});
  const closeButton=button('×',()=>close(),{class:'avatar-close','aria-label':'Close character creator',title:'Close (Escape)'});
  const heading=el('header',{class:'avatar-header'},el('div',{},el('span',{class:'avatar-eyebrow',text:'YOUR UNIVERSE CHARACTER'}),title,el('p',{text:'A little you. A little possibility.'})),closeButton);
  const canvas=el('canvas',{class:'avatar-preview',tabindex:'0','aria-label':'Live 3D character preview. Drag to orbit, use arrow keys to turn, plus or minus to zoom.','data-testid':'avatar-preview'});
  const previewError=el('p',{class:'avatar-preview-error',role:'status'});previewError.hidden=true;
  const stageLabel=el('span',{class:'avatar-stage-label',text:'Original Universe wardrobe'});
  const previewControls=el('div',{class:'avatar-orbit-controls'},button('↶',()=>orbit(-Math.PI/4),{'aria-label':'Rotate character preview left'}),button('Front',()=>front(),{'aria-label':'Show character front'}),button('↷',()=>orbit(Math.PI/4),{'aria-label':'Rotate character preview right'}),button('Back',()=>{if(camera)camera.alpha=-Math.PI/2;},{'aria-label':'Show character back'}));
  const animations=el('div',{class:'avatar-animation-controls','aria-label':'Preview animation'});
  for(const [id,label]of[['idle','Idle'],['walk','Walk'],['run','Fast walk']])animations.append(button(label,()=>{animation=id;for(const b of animations.children)b.setAttribute('aria-pressed',String(b.dataset.motion===animation));},{'aria-pressed':String(id==='idle'),'data-motion':id}));
  const stage=el('div',{class:'avatar-stage'},stageLabel,canvas,previewError,el('span',{class:'avatar-drag-hint',text:'Drag to turn · scroll to zoom'}),previewControls,animations);
  const tablist=el('div',{class:'avatar-tabs',role:'tablist','aria-label':'Character customization'});
  const fields=el('div',{class:'avatar-fields',role:'tabpanel'});
  const presetList=el('div',{class:'avatar-presets','aria-label':'Starting looks'});
  for(const p of AVATAR_PRESETS){const b=button(p.name,()=>{draft=normalizeAppearance(p.appearance);refresh();},{class:'avatar-preset','aria-label':`Try ${p.name}`,'data-preset':p.id});b.style.setProperty('--preset-color',p.appearance.topColor);presetList.append(b);}
  for(const id of Object.keys(TAB_FIELDS)){
    const b=button(TITLES[id],()=>setTab(id),{role:'tab',id:`${titleId}-${id}`,'aria-selected':String(id===activeTab),'aria-controls':`${titleId}-fields`,tabindex:id===activeTab?'0':'-1','data-tab':id});
    b.addEventListener('keydown',event=>{const ids=Object.keys(TAB_FIELDS),index=ids.indexOf(activeTab);let target;if(event.key==='ArrowRight')target=ids[(index+1)%ids.length];if(event.key==='ArrowLeft')target=ids[(index-1+ids.length)%ids.length];if(event.key==='Home')target=ids[0];if(event.key==='End')target=ids.at(-1);if(target){event.preventDefault();setTab(target);tablist.querySelector(`[data-tab="${target}"]`).focus();}});tablist.append(b);
  }
  fields.id=`${titleId}-fields`;
  const editPanel=el('div',{class:'avatar-edit-panel'},el('div',{class:'avatar-preset-title',text:'Start with a look, then make it yours'}),presetList,tablist,fields);
  const error=el('p',{class:'avatar-save-error',role:'alert'});
  const status=el('p',{class:'avatar-save-status',role:'status','aria-live':'polite',text:'Preview only. Save to apply.'});
  const cancelButton=button('Cancel',()=>close(),{class:'avatar-cancel'});
  const saveButton=button('Save character',save,{class:'avatar-save','data-testid':'avatar-save'});
  dialog.append(heading,el('div',{class:'avatar-workspace'},stage,editPanel),el('footer',{class:'avatar-footer'},el('div',{class:'avatar-footer-copy'},error,status),el('div',{class:'avatar-footer-actions'},cancelButton,saveButton)));
  root.replaceChildren(dialog);
  function getValue(key){return ['height','build'].includes(key)?draft.body[key]:draft[key];}
  function change(key,value){if(saving)return;if(['height','build'].includes(key))draft.body[key]=value;else draft[key]=value;refresh();}
  function field(key,label){
    const legend=el('legend',{text:label}),group=el('fieldset',{class:'avatar-field'},legend),items=AVATAR_OPTIONS[key]||AVATAR_PALETTES[key].map((id,i)=>({id,label:COLOR_NAMES[key][i]}));
    const options=el('div',{class:AVATAR_PALETTES[key]?'avatar-swatches':'avatar-choices'});
    for(const option of items){const attrs={'aria-label':`${label}: ${option.label}`,'aria-pressed':String(getValue(key)===option.id),'data-field':key,'data-value':option.id};const b=button(AVATAR_PALETTES[key]?'':option.label,()=>change(key,option.id),attrs);if(AVATAR_PALETTES[key]){b.className='avatar-swatch';b.style.setProperty('--swatch',option.id);b.title=option.label;}options.append(b);}
    group.append(options);return group;
  }
  function renderFields(){const previous=document.activeElement;const key=previous?.dataset?.field,value=previous?.dataset?.value;fields.replaceChildren(...TAB_FIELDS[activeTab].map(([key,label])=>field(key,label)));fields.setAttribute('aria-labelledby',`${titleId}-${activeTab}`);if(key)fields.querySelector(`[data-field="${key}"][data-value="${value}"]`)?.focus({preventScroll:true});}
  function setTab(id){activeTab=id;for(const b of tablist.children){b.setAttribute('aria-selected',String(b.dataset.tab===id));b.tabIndex=b.dataset.tab===id?0:-1;}renderFields();}
  function refresh(){rig?.setAppearance(draft);renderFields();for(const b of presetList.children){const p=AVATAR_PRESETS.find(p=>p.id===b.dataset.preset);b.setAttribute('aria-pressed',String(appearanceKey(draft)===appearanceKey(p.appearance)));}status.textContent=appearanceKey(draft)===baseline?'Preview only. Save to apply.':'Unsaved character changes.';}
  function front(){if(!camera)return;camera.alpha=Math.PI/2;camera.beta=1.34;camera.radius=3.6;}
  function orbit(amount){if(camera)camera.alpha+=amount;}
  function startPreview(){
    previewError.hidden=true;
    try{
      engine=new Engine(canvas,true,{preserveDrawingBuffer:true,stencil:false,alpha:true,doNotHandleTouchAction:true},false);resizeRenderBuffer(engine,canvas,PREVIEW_RENDER_PIXELS);
      scene=new Scene(engine);scene.clearColor=new Color4(0,0,0,0);
      camera=new ArcRotateCamera('wardrobe-orbit',Math.PI/2,1.34,3.6,new Vector3(0,1.04,0),scene);camera.lowerRadiusLimit=2.6;camera.upperRadiusLimit=5.5;camera.lowerBetaLimit=.7;camera.upperBetaLimit=1.75;camera.wheelPrecision=45;camera.panningSensibility=0;camera.minZ=.1;camera.fov=.68;camera.attachControl(canvas,true);camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
      const sky=new HemisphericLight('wardrobe-sky',new Vector3(.25,1,.4),scene);sky.intensity=.92;sky.groundColor=Color3.FromHexString('#8b7b9f');
      const key=new DirectionalLight('wardrobe-key',new Vector3(-.5,-1,-.7),scene);key.intensity=.65;key.diffuse=Color3.FromHexString('#fff1da');
      const fill=new HemisphericLight('wardrobe-fill',new Vector3(0,.15,-1),scene);fill.intensity=.20;fill.diffuse=Color3.FromHexString('#c9bfff');
      const mat=new StandardMaterial('wardrobe-plinth',scene);mat.diffuseColor=Color3.FromHexString('#ddd4ec');mat.specularColor=Color3.Black();const base=CreateCylinder('wardrobe-plinth',{height:.08,diameter:1.45,tessellation:64},scene);base.position.y=-.059;base.material=mat;
      rig=createAvatarRig(scene,draft,{id:'wardrobe-preview'});lastTime=performance.now();
      engine.runRenderLoop(()=>{if(!opened)return;const now=performance.now(),dt=Math.min(.1,(now-lastTime)/1000);lastTime=now;rig.update({dt,time:now/1000,heading:0,moving:animation!=='idle',running:animation==='run'});scene.render();renderedFrames++;});
      observer=new ResizeObserver(()=>{if(engine)resizeRenderBuffer(engine,canvas,PREVIEW_RENDER_PIXELS);});observer.observe(canvas);resizeRenderBuffer(engine,canvas,PREVIEW_RENDER_PIXELS);
    }catch(e){stopPreview();previewError.textContent='The live 3D preview could not start. Your saved character is safe. Try reopening in a WebGL-capable browser.';previewError.hidden=false;}
  }
  function stopPreview(){observer?.disconnect();observer=null;rig?.dispose();rig=null;scene?.dispose();scene=null;engine?.dispose();engine=null;camera=null;}
  async function save(){
    if(saving||!opened)return;error.textContent='';let appearance;
    try{appearance=validateAppearance(draft);}catch(e){error.textContent=e.message;return;}
    saving=true;saveButton.disabled=true;saveButton.textContent='Saving…';cancelButton.disabled=true;closeButton.disabled=true;editPanel.inert=true;const request=generation;
    try{
      let savedUser;if(commitOverride){await commitOverride(appearance);savedUser={...getState?.()?.user,appearance};}
      else{const response=await api('/api/me',{method:'PATCH',body:{appearance}});savedUser=response.user;await onSaved(savedUser);}
      if(request!==generation||destroyed)return;
      toast(commitOverride?'Character ready for your adventure':'Character saved. See you out there!');close(true);
    }catch(e){if(request===generation&&!destroyed){error.textContent=e.message||'Your character could not be saved. Try again.';status.textContent='Your draft is still here.';}}
    finally{saving=false;if(!destroyed){saveButton.disabled=false;saveButton.textContent='Save character';cancelButton.disabled=false;closeButton.disabled=false;editPanel.inert=false;}}
  }
  function open(options={}){
    if(destroyed||opened)return;generation++;opened=true;saving=false;returnFocus=document.activeElement;commitOverride=options.onCommit||null;
    draft=normalizeAppearance(options.appearance??appearanceForUser(getState?.()?.user));baseline=appearanceKey(draft);error.textContent='';animation='idle';for(const b of animations.children)b.setAttribute('aria-pressed',String(b.dataset.motion==='idle'));root.hidden=false;dialog.scrollTop=0;editPanel.scrollTop=0;refresh();onOpenChange(true);startPreview();closeButton.focus({preventScroll:true});
  }
  function close(force=false){if(!opened||(saving&&!force))return;opened=false;generation++;root.hidden=true;stopPreview();onOpenChange(false);if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});else(document.querySelector('[data-avatar-trigger]')||document.getElementById('game'))?.focus({preventScroll:true});}
  function onKey(event){if(!opened)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}if(event.key==='Tab'){const focusables=[...dialog.querySelectorAll('button:not(:disabled),canvas,[tabindex="0"]')].filter(n=>n.offsetParent!==null&&!n.closest('[inert]'));const first=focusables[0],last=focusables.at(-1);if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}event.stopPropagation();}
  const canvasKey=event=>{const actions={ArrowLeft:()=>orbit(-Math.PI/12),ArrowRight:()=>orbit(Math.PI/12),ArrowUp:()=>{if(camera)camera.beta=Math.max(.7,camera.beta-.12);},ArrowDown:()=>{if(camera)camera.beta=Math.min(1.75,camera.beta+.12);},'+':()=>{if(camera)camera.radius=Math.max(2.6,camera.radius-.2);},'-':()=>{if(camera)camera.radius=Math.min(5.5,camera.radius+.2);},Home:front};if(actions[event.key]){event.preventDefault();actions[event.key]();}};
  canvas.addEventListener('keydown',canvasKey);root.addEventListener('keydown',onKey);root.addEventListener('keyup',event=>{if(opened)event.stopPropagation();});
  return {open,close,isOpen:()=>opened,getDraft:()=>normalizeAppearance(draft),getPreviewState:()=>({renderedFrames,active:!!engine,camera:camera?{alpha:camera.alpha,beta:camera.beta,radius:camera.radius}:null,meshCount:rig?.meshes.length||0}),destroy(){close(true);destroyed=true;root.removeEventListener('keydown',onKey);root.replaceChildren();}};
}

// Small, genuine 3D portraits for onboarding and social UI. Requests are serialized
// through one temporary renderer (not one WebGL context per card), with a bounded
// appearance cache. The renderer releases its context after a burst of requests.
const portraits=new Map();let portraitQueue=Promise.resolve(),portraitRenderer=null,portraitRelease=null;
export function createAvatarPortrait(value){
  const appearance=normalizeAppearance(value),key=appearanceKey(appearance);
  if(portraits.has(key))return portraits.get(key);
  const request=portraitQueue.then(async()=>{
    clearTimeout(portraitRelease);
    if(!portraitRenderer){
      const canvas=document.createElement('canvas');canvas.width=160;canvas.height=160;
      const engine=new Engine(canvas,true,{preserveDrawingBuffer:true,alpha:true,stencil:false,loseContextOnDispose:true},false),scene=new Scene(engine);scene.clearColor=new Color4(0,0,0,0);
      const camera=new ArcRotateCamera('portrait-camera',1.42,1.36,3.1,new Vector3(0,1.50,0),scene);camera.fov=.64;camera.minZ=.1;
      const light=new HemisphericLight('portrait-sky',new Vector3(.2,1,.8),scene);light.intensity=1.05;light.groundColor=Color3.FromHexString('#8b7b9f');
      const keyLight=new DirectionalLight('portrait-key',new Vector3(-.5,-1,-.7),scene);keyLight.intensity=.55;
      portraitRenderer={engine,scene,canvas};
    }
    const {engine,scene,canvas}=portraitRenderer,rig=createAvatarRig(scene,appearance,{id:'portrait'});
    try{rig.update({heading:0,dt:0,time:0});await scene.whenReadyAsync();scene.render();scene.render();return canvas.toDataURL('image/png');}
    finally{rig.dispose();portraitRelease=setTimeout(()=>{portraitRenderer?.scene.dispose();portraitRenderer?.engine.dispose();portraitRenderer=null;},1500);}
  });
  portraits.set(key,request);while(portraits.size>48)portraits.delete(portraits.keys().next().value);
  portraitQueue=request.catch(()=>{});request.catch(()=>portraits.delete(key));return request;
}
