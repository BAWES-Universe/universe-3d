import test from 'node:test';
import assert from 'node:assert/strict';
import {mountActionRuntime} from '../src/action-runtime.js';
// Minimal DOM ownership model. Native iframe loading/form behavior is proved by the browser suite.
class Node {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.hidden=false;this.style={setProperty(){}};this.isConnected=true;this.listeners={};}
 append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
 replaceChildren(...nodes){for(const node of this.children)node.parentElement=null;this.children=[];this.append(...nodes);}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null;}
 setAttribute(name,value){this.attributes[name]=value;}
 removeAttribute(name){delete this.attributes[name];}
 addEventListener(name,fn){this.listeners[name]=fn;}
 removeEventListener(name){delete this.listeners[name];}
 contains(node){return node===this||this.children.some(child=>child.contains(node));}
 getClientRects(){return this.hidden?[]:[{}];}
 focus(){document.activeElement=this;}
}
function fixture(){
 const body=new Node('body');globalThis.document={activeElement:body,createElement:tag=>new Node(tag),addEventListener(){},removeEventListener(){}};globalThis.location={origin:'http://127.0.0.1'};globalThis.localStorage={getItem:()=>null};
 const action={id:'embed',type:'link',url:'https://local-fixture.invalid/form',mode:'embed',label:'Local form'},item={id:'board',type:'board',x:0,z:0,actions:[action]};
 const state={ready:true,user:{id:'alice'},room:{id:'room',revision:1},scene:{objects:[item],areas:[]},position:{x:0,z:0}},root=new Node('div'),controlsRoot=new Node('div'),calls=[],changes=[];
 let resolve=async(url,options)=>({revision:1,action:item.actions.find(candidate=>candidate.id===options.body.actionId),entity:{name:'Board'}});
 const runtime=mountActionRuntime({root,controlsRoot,getState:()=>state,api:async(...args)=>{calls.push(args);return resolve(...args);},onOpenChange:open=>changes.push(open)});runtime.update();
 const ref={roomId:'room',entityType:'item',entityId:'board',actionId:'embed'};
 const all=(node=root)=>[node,...node.children.flatMap(n=>all(n))];
 return{runtime,state,action,item,root,body,calls,changes,all,setResolver:fn=>resolve=fn,open:(actionId='embed')=>runtime.activate({...ref,actionId})};
}
test('iframe DOM ownership survives foreground history metadata work; explicit close disposes and restore reauthorizes',async()=>{
 const f=fixture();try{assert(await f.open());const frame=f.all().find(n=>n.tagName==='iframe'),key=f.runtime.historyKey();assert.match(key,/^[\w-]+$/);frame.localFormDraft='typed state';
 assert.equal(f.runtime.isOpen(),true);assert.match(frame.attributes.allow,/camera 'none'/);assert.match(frame.attributes.allow,/microphone 'none'/);assert.match(frame.attributes.allow,/display-capture 'none'/);assert.doesNotMatch(frame.attributes.sandbox,/allow-top-navigation|allow-popups-to-escape-sandbox/);assert.equal(f.all().find(n=>n.tagName==='iframe'),frame);assert.equal(f.calls.length,1);
 f.runtime.close();assert.equal(frame.src,'about:blank');assert.equal(f.runtime.isOpen(),false);assert(await f.runtime.restore(key,{focus:false}));assert.equal(f.calls.length,2);assert.notEqual(f.all().find(n=>n.tagName==='iframe'),frame);assert.equal(f.runtime.historyKey(),key);
 }finally{f.runtime.destroy();}
});
test('background restore does not steal existing focus and denied reopen creates no iframe',async()=>{
 const f=fixture();try{await f.open();const key=f.runtime.historyKey();f.runtime.close();f.body.focus();assert(await f.runtime.restore(key,{focus:false}));assert.equal(document.activeElement,f.body);f.runtime.close();f.setResolver(async()=>{throw Error('Denied')});assert.equal(await f.runtime.restore(key),false);assert.equal(f.runtime.isOpen(),false);assert.equal(f.all().filter(n=>n.tagName==='iframe').length,0);}finally{f.runtime.destroy();}
});
test('cancelled slow restore cannot reopen after Back and newer restore can complete first',async()=>{
 const f=fixture();try{await f.open();const key=f.runtime.historyKey();f.runtime.close();let release;f.setResolver(()=>new Promise(resolve=>release=resolve));const old=f.runtime.restore(key);await Promise.resolve();await Promise.resolve();f.runtime.close();f.setResolver(async()=>({revision:1,action:f.action,entity:{name:'Board'}}));assert(await f.runtime.restore(key));const frame=f.all().find(n=>n.tagName==='iframe');release({revision:1,action:f.action,entity:{name:'Board'}});assert.equal(await old,null);assert.equal(f.all().find(n=>n.tagName==='iframe'),frame);}finally{f.runtime.destroy();}
});
test('room, account, authority, action removal and changed action invalidate restoration',async()=>{
 for(const mutate of [f=>f.state.room.id='other',f=>f.state.user.id='bob',f=>f.state.ready=false,f=>f.state.scene.objects=[],f=>f.action.url='https://changed.invalid/']){
  const f=fixture();try{await f.open();const key=f.runtime.historyKey();f.runtime.close();mutate(f);f.runtime.update();const calls=f.calls.length;assert.equal(await f.runtime.restore(key),false);assert.equal(f.calls.length,calls);assert.equal(f.runtime.isOpen(),false);}finally{f.runtime.destroy();}
 }
});
test('account changes during an unresolved response cannot open the old account frame before update runs',async()=>{
 const f=fixture();try{await f.open();const key=f.runtime.historyKey();f.runtime.close();let release;f.setResolver(()=>new Promise(resolve=>release=resolve));const pending=f.runtime.restore(key);await Promise.resolve();await Promise.resolve();f.state.user.id='bob';release({revision:1,action:f.action,entity:{name:'Board'}});assert.equal(await pending,false);assert.equal(f.runtime.isOpen(),false);}finally{f.runtime.destroy();}
});

test('releasing the latest of two live frames retains the content history key and earlier iframe node',async()=>{
 const f=fixture();try{await f.open();const first=f.all().find(n=>n.tagName==='iframe'),contentKey=f.runtime.historyKey();first.localFormDraft='keep earlier draft';
  f.item.actions.push({...f.action,id:'second',url:'https://local-fixture.invalid/second',label:'Second form'});await f.open('second');assert.equal(f.all().filter(n=>n.tagName==='iframe').length,2);assert.equal(f.runtime.historyKey(),contentKey);
  f.item.actions=f.item.actions.filter(action=>action.id!=='second');f.runtime.update();assert.equal(f.runtime.isOpen(),true);assert.equal(f.runtime.historyKey(),contentKey,'Releasing a latest reference must not invalidate the still-live content group');assert.equal(f.all().find(n=>n.tagName==='iframe'),first);assert.equal(first.localFormDraft,'keep earlier draft');assert.equal(f.calls.length,2);assert.deepEqual(f.changes,[true]);
  // This is the production popstate ownership condition: a matching live group
  // is retained, without restore/reload, when a foreground surface is dismissed.
  if(f.runtime.historyKey()!==contentKey)f.runtime.close();assert.equal(f.all().find(n=>n.tagName==='iframe'),first);
  f.runtime.close();assert.equal(await f.runtime.restore(contentKey),false,'No fallback multi-tab reopening is introduced after the latest reference was revoked');assert.equal(f.calls.length,2);
 }finally{f.runtime.destroy();}
});
test('explicit latest-panel Close and subsequent release keep earlier content until its own release',async()=>{
 const f=fixture();try{await f.open();const first=f.all().find(n=>n.tagName==='iframe'),contentKey=f.runtime.historyKey();f.item.actions.push({...f.action,id:'second',url:'https://local-fixture.invalid/second',label:'Second form'});await f.open('second');
  f.all().find(n=>n.tagName==='button'&&n.textContent==='Close this panel').onclick();assert.equal(f.all().find(n=>n.tagName==='iframe'),first);assert.equal(f.runtime.historyKey(),contentKey);assert.equal(f.runtime.isOpen(),true);
  f.item.actions=f.item.actions.filter(action=>action.id!=='second');f.runtime.update();assert.equal(f.all().find(n=>n.tagName==='iframe'),first);assert.equal(f.runtime.historyKey(),contentKey);
  f.item.actions=[];f.runtime.update();assert.equal(f.runtime.isOpen(),false);assert.equal(f.runtime.historyKey(),null);assert.equal(await f.runtime.restore(contentKey),false);
 }finally{f.runtime.destroy();}
});

test('releasing an earlier frame preserves the latest live node and its one-reference authorized reopening',async()=>{
 const f=fixture();try{await f.open();const first=f.all().find(n=>n.tagName==='iframe'),contentKey=f.runtime.historyKey();f.item.actions.push({...f.action,id:'second',url:'https://local-fixture.invalid/second',label:'Second form'});await f.open('second');const second=f.all().filter(n=>n.tagName==='iframe').find(n=>n!==first);second.localFormDraft='latest draft';
  f.item.actions=f.item.actions.filter(action=>action.id==='second');f.runtime.update();assert.equal(first.src,'about:blank');assert.equal(f.all().find(n=>n.tagName==='iframe'),second);assert.equal(second.localFormDraft,'latest draft');assert.equal(f.runtime.historyKey(),contentKey);assert.equal(f.calls.length,2);
  f.runtime.close();assert.equal(f.all().filter(n=>n.tagName==='iframe').length,0);assert.equal(second.src,'about:blank');assert(await f.runtime.restore(contentKey));assert.equal(f.calls.length,3);assert.equal(f.calls.at(-1)[1].body.actionId,'second');assert.notEqual(f.all().find(n=>n.tagName==='iframe'),second);
 }finally{f.runtime.destroy();}
});
