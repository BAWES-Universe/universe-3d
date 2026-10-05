import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createFurniture} from '../modules/asset-workshop/model.js';

// CPU state-machine tests, not a substitute for the real-browser suites. Import
// the production controller unchanged apart from its CSS and GPU-view imports.
// The tiny DOM below models the controller's element, focus, input and change
// contracts; the view's readiness promise and HTTP responses remain controllable.
const controllerUrl=new URL('../src/workshop.js',import.meta.url);
let controllerSource=await readFile(controllerUrl,'utf8');
assert.match(controllerSource,/import \{createView\} from '\.\.\/modules\/asset-workshop\/view\.js';/);
controllerSource=controllerSource
 .replace("import {createView} from '../modules/asset-workshop/view.js';",'const createView=canvas=>canvas.createTestView();')
 .replace("import './workshop.css';",'')
 .replace(/from '([^']+)'/g,(_,path)=>`from '${new URL(path,controllerUrl).href}'`);
const {mountWorkshop}=await import('data:text/javascript;base64,'+Buffer.from(controllerSource).toString('base64'));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};

function fixture(t){
 const previous={document:globalThis.document,window:globalThis.window};
 const views=[],viewReadiness=[],requests=[],updates=[],confirms=[];
 let queuedRead=null,saveCount=0;
 const document={activeElement:null,hidden:false,addEventListener(){},removeEventListener(){}};
 class Element {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.attributes={};this.dataset={};this.listeners=new Map();this.value='';this.hidden=false;this.disabled=false;this.connected=false;}
  get isConnected(){return this.connected||!!this.parentElement?.isConnected;}
  append(...values){for(const value of values){value.parentElement=this;this.children.push(value);}}
  prepend(value){value.parentElement=this;this.children.unshift(value);}
  replaceChildren(...values){for(const child of this.children){if(child.contains(document.activeElement))document.activeElement=document.body;child.parentElement=null;}this.children=[];this.append(...values);}
  setAttribute(key,value){this.attributes[key]=String(value);}
  getAttribute(key){return key==='aria-label'?this.ariaLabel:this.attributes[key];}
  contains(value){return value===this||this.children.some(child=>child.contains(value));}
  matches(selector){return selector==='[contenteditable]'?!!this.isContentEditable:this.tagName.toLowerCase()===selector;}
  querySelectorAll(selector){const selectors=selector.split(',');return this.children.flatMap(child=>[...(selectors.some(s=>child.matches(s))?[child]:[]),...child.querySelectorAll(selector)]);}
  closest(selector){return selector.split(',').some(s=>this.matches(s))?this:this.parentElement?.closest(selector)||null;}
  addEventListener(type,listener){this.listeners.set(type,listener);}
  removeEventListener(type){this.listeners.delete(type);}
  focus(){
   if(this.disabled||!this.isConnected)return;
   const old=document.activeElement;if(old===this)return;
   // A real user leaving a changed text field commits change synchronously.
   if(old?.focusValue!==undefined&&old.value!==old.focusValue)old.onchange?.();
   document.activeElement=this;this.focusValue=this.value;
  }
  setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
  getClientRects(){for(let n=this;n;n=n.parentElement)if(n.hidden)return[];return this.isConnected?[{}]:[];}
  click(){if(!this.disabled)this.onclick?.();}
  setPointerCapture(){}
  releasePointerCapture(){}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;this.connected=false;}
  createTestView(){
   const view={ready:viewReadiness.shift()||Promise.resolve(),disposed:false,update(){},focus(){},dispose(){this.disposed=true;},diagnostics(){return{frames:0,meshes:0,materials:0,parts:[]};}};
   views.push(view);return view;
  }
 }
 document.body=new Element('body');document.body.connected=true;document.activeElement=document.body;
 document.createElement=tag=>new Element(tag);document.createTextNode=text=>Object.assign(new Element('text'),{textContent:text});
 const game=new Element('canvas');document.body.append(game);document.getElementById=id=>id==='game'?game:null;
 globalThis.document=document;globalThis.window={confirm:message=>{confirms.push(message);return true;},addEventListener(){},removeEventListener(){}};
 const asset=(id,kind)=>{const definition=createFurniture(kind);definition.asset={id,revision:1,name:id};return{assetId:id,revision:1,roomId:'room-a',status:'active',definition};};
 const assets=[asset('source-a','chair'),asset('source-b','table')];
 const state={ready:true,user:{id:'user-a'},room:{id:'room-a',capabilities:{canEditScene:true}},scene:{objects:[]}};
 const root=new Element('section');document.body.append(root);
 const panel=mountWorkshop({root,getState:()=>state,onChoose:()=>false,onUpdate:(id,ref)=>{updates.push({id,ref});return true;},
  api:async(path,options)=>{
   requests.push({path,options});
   if(!options){if(queuedRead){const next=queuedRead;queuedRead=null;return next;}return{assets:structuredClone(assets)};}
   const id=path.split('/').at(-1),index=assets.findIndex(asset=>asset.assetId===id);
   assert.equal(options.method,'PUT');assert.notEqual(index,-1);
   const definition=structuredClone(options.body.definition),revision=assets[index].revision+1;
   definition.asset={...definition.asset,id,revision};assets[index]={...assets[index],revision,definition};saveCount++;
   return{asset:structuredClone(assets[index])};
  }});
 t.after(()=>{panel.dispose();globalThis.document=previous.document;globalThis.window=previous.window;});
 const button=label=>{const node=root.querySelectorAll('button').find(node=>node.textContent===label);assert(node,`Missing button ${label}`);return node;};
 const field=label=>{const node=root.querySelectorAll('input,select').find(node=>node.ariaLabel===label);assert(node,`Missing field ${label}`);return node;};
 const type=(node,value)=>{node.focus();node.value=String(value);node.oninput?.();};
 const click=label=>{const node=button(label);assert(node.getClientRects().length,`${label} is hidden`);assert(!node.disabled,`${label} is disabled`);node.focus();node.click();};
 const importFile=read=>{const node=root.querySelectorAll('input').find(node=>node.type==='file');node.files=[{size:100,text:()=>read}];return node.onchange();};
 const openSource=(id='source-a',instanceId='placed-a')=>panel.open({assetRef:{assetId:id,revision:1},instanceId});
 const settle=async predicate=>{for(let i=0;i<25&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,0));assert(predicate(),'Controller did not reach the expected settled state');};
 return{panel,root,state,assets,views,requests,updates,confirms,button,field,type,click,importFile,openSource,settle,
  delayView:promise=>viewReadiness.push(promise),delayRead:promise=>{queuedRead=promise;},get saveCount(){return saveCount;}};
}

test('workshop delayed import cannot replace newer uncommitted name or inspector input',async t=>{
 const f=fixture(t);await f.openSource();const original=f.panel.getPreviewState().document;
 let file=deferred(),pending=f.importFile(file.promise);f.type(f.field('Furniture name'),'A newer uncommitted name');
 file.resolve(JSON.stringify(f.assets[1].definition));await pending;
 assert.deepEqual(f.panel.getPreviewState().document,original);assert.equal(f.field('Furniture name').value,'A newer uncommitted name');
 f.click(original.components[0].name); // Commits the name before selecting a part.
 f.click('Ungroup parts');f.click(original.components[0].name);
 const before=f.panel.getPreviewState().document;file=deferred();pending=f.importFile(file.promise);
 f.type(f.field('Size X'),2.5);file.resolve(JSON.stringify(f.assets[1].definition));await pending;
 assert.deepEqual(f.panel.getPreviewState().document,before);assert.equal(f.field('Size X').value,'2.5');
});

test('workshop pending source load cannot target a different placement after editing the retained draft',async t=>{
 const f=fixture(t);await f.openSource();f.panel.close({force:true});
 const ready=deferred();f.delayView(ready.promise);const opening=f.openSource('source-b','placed-b');
 f.type(f.field('Furniture name'),'Edited A while B is opening');ready.resolve();await opening;
 assert.equal(f.panel.getPreviewState().document.asset.id,'source-a');
 assert.equal(f.button('Update placed copy').hidden,true);
 f.click('Save furniture');await f.settle(()=>f.saveCount===1&&!f.button('Save furniture').disabled);
 assert.equal(f.assets[0].definition.asset.name,'Edited A while B is opening');
 assert.equal(f.button('Update placed copy').hidden,true);assert.deepEqual(f.updates,[]);
 // A subsequent successful source load binds the intended source and target.
 await f.openSource('source-b','placed-b');assert.equal(f.panel.getPreviewState().document.asset.id,'source-b');
 f.click('Update placed copy');assert.deepEqual(f.updates,[{id:'placed-b',ref:{assetId:'source-b',revision:1}}]);
});

test('workshop delayed catalog source load also respects newer uncommitted input',async t=>{
 const f=fixture(t);await f.openSource();const read=deferred();f.delayRead(read.promise);
 const opening=f.openSource('source-b','placed-b');f.type(f.field('Furniture name'),'Keep typing source A');
 read.resolve({assets:structuredClone(f.assets)});await opening;
 assert.equal(f.panel.getPreviewState().document.asset.id,'source-a');assert.equal(f.field('Furniture name').value,'Keep typing source A');
 assert.equal(f.button('Update placed copy').hidden,true);assert.deepEqual(f.updates,[]);
});

test('workshop delayed import and preview readiness cannot overwrite a later room',async t=>{
 const f=fixture(t);await f.openSource();const file=deferred(),pending=f.importFile(file.promise);f.panel.close({force:true});
 const ready=deferred();f.delayView(ready.promise);const oldOpening=f.openSource('source-b','placed-b');f.panel.close({force:true});
 f.state.room={id:'room-b',capabilities:{canEditScene:true}};f.state.scene={objects:[]};await f.panel.open();
 const next=f.panel.getPreviewState().document,currentView=f.views.at(-1);file.resolve(JSON.stringify(f.assets[1].definition));ready.resolve();await pending;await oldOpening;
 assert.deepEqual(f.panel.getPreviewState().document,next);assert.equal(f.panel.isOpen(),true);assert.equal(currentView.disposed,false);
 assert.equal(f.views.slice(0,-1).every(view=>view.disposed),true);assert.equal(f.button('Update placed copy').hidden,true);
 assert.deepEqual(f.updates,[]);
});
