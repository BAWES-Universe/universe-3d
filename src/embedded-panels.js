import {safeActionUrl} from './action-schema.js';
import {contentWindowLayout, CONTENT_RESIZE_STEP} from './window-layout.js';
const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
/** Sandboxed provider frames; loading is never asserted to prove provider acceptance.
 * onWindowChange reports visual state only; the shell owns foreground ordering/inert siblings.
 */
export function mountEmbeddedPanels({root,onOpenChange=()=>{},onWindowChange=()=>{},getGameWidth,toast=()=>{}}){
 const entries=new Map();let selected=null,focusBefore=null,maximized=false,foreground=true,gesture=null,keyboardStart=null,destroyed=false,lastWindowState='';
 const view=globalThis.window;
 root.className='embedded-overlay';root.hidden=true;
 const startGuard=element('span','embedded-focus-guard'),endGuard=element('span','embedded-focus-guard');
 startGuard.tabIndex=endGuard.tabIndex=-1;startGuard.setAttribute('data-focus-guard','start');endGuard.setAttribute('data-focus-guard','end');
 startGuard.setAttribute('aria-label','Start of room content');endGuard.setAttribute('aria-label','End of room content');
 const panel=element('section','embedded-panel');panel.setAttribute('role','region');panel.setAttribute('aria-label','Room content');
 const header=element('header','embedded-header'),heading=element('strong','', 'Room content'),leave=element('button','small-btn','Return to world');leave.type='button';leave.onclick=()=>clear();
 const maximize=element('button','small-btn embedded-maximize','Maximize');maximize.type='button';maximize.onclick=()=>setMaximized(!maximized);
 const tabs=element('div','embedded-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Open room content');
 const status=element('p','embedded-status'),actions=element('div','embedded-actions'),external=element('button','small-btn','Open in new tab ↗'),retry=element('button','small-btn','Reload frame'),close=element('button','small-btn','Close this panel');
 const resize=element('button','embedded-resize');resize.type='button';resize.setAttribute('aria-label','Resize content window');resize.title='Resize content window. Drag, or use Left and Right arrow keys. Enter starts or finishes keyboard resizing; Escape cancels.';
 const resizeHint=element('span','embedded-resize-hint');resizeHint.id='embedded-resize-instructions';resizeHint.textContent='Use Left to widen, Right to narrow, Shift for a larger step, Home for minimum, End for maximum. Enter or Space starts or finishes resizing. Escape cancels.';resize.setAttribute('aria-describedby',resizeHint.id);
 const sizeStatus=element('span','embedded-size-status');sizeStatus.setAttribute('role','status');sizeStatus.setAttribute('aria-live','polite');
 for(const b of[external,retry,close])b.type='button';header.append(heading,leave,maximize);actions.append(external,retry,close);const frames=element('div','embedded-frames');panel.append(header,tabs,status,actions,frames);root.append(startGuard,panel,resize,resizeHint,sizeStatus,endGuard);
 // Native Tab can leave a cross-origin document without a host key event.
 // These boundaries catch that focus transition while content owns the screen.
 startGuard.onfocus=()=>{if(maximized&&foreground&&!root.hidden)(current()?.frame||close).focus();};
 endGuard.onfocus=()=>{if(maximized&&foreground&&!root.hidden)leave.focus();};
 function current(){return entries.get(selected);}
 function viewport(){
  const width=view?.innerWidth||document.documentElement?.clientWidth||1024,height=view?.innerHeight||document.documentElement?.clientHeight||768;
  return {width:Math.min(width,view?.visualViewport?.width||width),height:Math.min(height,view?.visualViewport?.height||height)};
 }
 function layout(){const size=viewport();return contentWindowLayout({viewportWidth:size.width,viewportHeight:size.height,gameWidth:getGameWidth?.()??size.width,authoredWidth:current()?.width,customWidth:current()?.windowWidth,maximized});}
 function windowState(){const geometry=layout();return {open:!root.hidden,maximized,foreground,resizing:!!gesture||keyboardStart!==null,width:geometry.width,canMaximize:geometry.canMaximize,canResize:geometry.canResize};}
 function publish(){const state=windowState(),signature=JSON.stringify(state);if(signature!==lastWindowState){lastWindowState=signature;onWindowChange(state);}}
 function applyLayout({announce=false}={}){
  const geometry=layout();maximized=geometry.maximized;
  root.setAttribute('data-maximized',String(maximized));root.setAttribute('data-resizing',String(!!gesture||keyboardStart!==null));root.inert=maximized&&!foreground;
  startGuard.tabIndex=endGuard.tabIndex=maximized&&foreground&&!root.hidden?0:-1;
  root.style.setProperty('--window-width',geometry.width+'px');root.style.setProperty('--window-height',geometry.height+'px');
  root.style.setProperty('--window-viewport-width',viewport().width+'px');
  maximize.hidden=!geometry.canMaximize;maximize.textContent=maximized?'Restore':'Maximize';maximize.setAttribute('aria-label',maximized?'Restore content window':'Maximize content window');maximize.setAttribute('aria-pressed',String(maximized));
  resize.hidden=!geometry.canResize;resize.setAttribute('aria-pressed',String(keyboardStart!==null));
  if(announce)sizeStatus.textContent=`Content window ${Math.round(geometry.width)} pixels wide`;
  publish();
 }
 function finishResize({cancel=false,announce=true}={}){
  const started=gesture||keyboardStart;
  if(!started)return false;
  // Clear before releasing capture because lostpointercapture may fire synchronously.
  const pointer=gesture;gesture=null;keyboardStart=null;
  if(cancel&&entries.has(started.key))entries.get(started.key).windowWidth=started.width;
  if(pointer&&resize.hasPointerCapture?.(pointer.id))resize.releasePointerCapture(pointer.id);
  applyLayout({announce});return true;
 }
 function changeWidth(width){const item=current();if(!item||!layout().canResize)return;const bounds=layout();item.windowWidth=Math.max(bounds.minWidth,Math.min(width,bounds.maxWidth));applyLayout();}
 function setMaximized(value){
  if(!current()||!layout().canMaximize)return false;
  finishResize({announce:false});maximized=!!value;applyLayout();maximize.focus();return true;
 }
 function setForeground(value){const next=!!value;if(foreground===next)return;foreground=next;if(!next)finishResize({cancel:true,announce:false});applyLayout();}
 function handleEscape(event){
  if(root.hidden||!foreground||event?.isComposing||event?.defaultPrevented)return false;
  if(!finishResize({cancel:true}))clear();
  event?.preventDefault();event?.stopPropagation();return true;
 }
 resize.addEventListener('pointerdown',event=>{
  if(event.button!==0||event.isPrimary===false||!layout().canResize||!foreground)return;
  finishResize({announce:false});gesture={id:event.pointerId,x:event.clientX,start:layout().width,width:current().windowWidth,key:selected};
  resize.setPointerCapture?.(event.pointerId);resize.focus();event.preventDefault();event.stopPropagation();applyLayout();
 });
 resize.addEventListener('pointermove',event=>{if(!gesture||event.pointerId!==gesture.id)return;changeWidth(gesture.start+gesture.x-event.clientX);event.preventDefault();event.stopPropagation();});
 resize.addEventListener('pointerup',event=>{if(gesture?.id!==event.pointerId)return;finishResize();event.preventDefault();event.stopPropagation();});
 resize.addEventListener('pointercancel',event=>{if(gesture?.id===event.pointerId)finishResize({cancel:true});});
 resize.addEventListener('lostpointercapture',()=>finishResize({cancel:true}));
 resize.onclick=event=>{
  // Native keyboard activation has detail=0. Pointer drag completion must not start another session.
  if(event.detail!==0||!layout().canResize)return;
  if(keyboardStart!==null)finishResize();else{keyboardStart={key:selected,width:current().windowWidth};applyLayout({announce:true});}
 };
 resize.addEventListener('keydown',event=>{
  if(event.isComposing||!layout().canResize||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  if(keyboardStart===null)keyboardStart={key:selected,width:current().windowWidth};
  const bounds=layout(),step=CONTENT_RESIZE_STEP*(event.shiftKey?4:1);
  changeWidth(event.key==='Home'?bounds.minWidth:event.key==='End'?bounds.maxWidth:bounds.width+(event.key==='ArrowLeft'?step:-step));
  applyLayout({announce:true});event.preventDefault();event.stopPropagation();
 });
 resize.addEventListener('blur',()=>{if(keyboardStart!==null)finishResize();});
 const blur=()=>finishResize({cancel:true});
 const resizeViewport=()=>{
  if(destroyed)return;
  const hadMaximized=maximized,hadHandleFocus=document.activeElement===resize;
  finishResize({cancel:true,announce:false});
  for(const item of entries.values())if(item.windowWidth!=null){const bounds=layout();item.windowWidth=Math.max(bounds.minWidth,Math.min(item.windowWidth,bounds.maxWidth));}
  applyLayout();if(!root.hidden&&foreground&&((hadMaximized&&!maximized)||(hadHandleFocus&&resize.hidden)))leave.focus();
 };
 view?.addEventListener?.('blur',blur);view?.addEventListener?.('resize',resizeViewport);view?.visualViewport?.addEventListener('resize',resizeViewport);
 external.onclick=()=>current()?.onExternal?.();retry.onclick=()=>{const item=current();if(item)load(item);};close.onclick=()=>closeEntry(selected);
 function draw(){
  const item=current();if(!item)return;
  heading.textContent=item.title;status.textContent=item.status;close.hidden=item.closable===false;retry.disabled=!item.embeddable;
  // Tab buttons and frame holders stay in place on load, resize and selection updates.
  for(const [key,value]of entries){value.tab.setAttribute('aria-selected',String(key===selected));value.holder.hidden=key!==selected;}
  tabs.hidden=entries.size<2;applyLayout();
 }
 function load(item){
  clearTimeout(item.timer);item.frame?.remove();item.frame=null;item.holder.replaceChildren();
  const parsed=safeActionUrl(item.url,location.origin);item.embeddable=parsed?.kind==='external'&&parsed.protocol==='https:';
  if(!item.embeddable){item.status='This address must open separately. Protected documents download instead of loading inside a frame.';draw();return;}
  item.status='Opening site. If it stays blank or the site refuses embedding, use Open in new tab.';
  const frame=element('iframe','embedded-frame');item.frame=frame;frame.title=item.title;frame.referrerPolicy='no-referrer';
  frame.setAttribute('sandbox','allow-scripts allow-forms allow-same-origin allow-popups allow-downloads');
  frame.setAttribute('allow','fullscreen');frame.src=item.url;
  frame.onload=()=>{if(entries.get(item.key)!==item||item.frame!==frame)return;clearTimeout(item.timer);item.status='Site frame opened. If its contents are blank or blocked, use Open in new tab.';if(selected===item.key)draw();};
  frame.onerror=()=>{if(entries.get(item.key)!==item||item.frame!==frame)return;clearTimeout(item.timer);item.status='The site could not be displayed here. Open it in a new tab, or choose Reload frame.';if(selected===item.key)draw();};
  item.holder.append(frame);item.timer=setTimeout(()=>{if(entries.get(item.key)!==item||item.frame!==frame)return;item.status='Still loading, or the site may prohibit embedding. Open in new tab remains available.';if(selected===item.key)draw();},10000);draw();
 }
 function open(config,{focus=true}={}){
  let item=entries.get(config.key);finishResize({cancel:true,announce:false});
  if(!item){
   if(entries.size>=5){toast('Close an open content panel before opening another');return false;}
   item={...config,title:config.title||'Room content',holder:element('div','embedded-frame-holder'),tab:element('button'),status:'Opening content…',frame:null,timer:null,windowWidth:null};
   item.tab.type='button';item.tab.textContent=item.title;item.tab.setAttribute('role','tab');item.tab.onclick=()=>{finishResize({cancel:true,announce:false});selected=item.key;draw();};entries.set(item.key,item);frames.append(item.holder);tabs.append(item.tab);
  }else if(item.url!==config.url){Object.assign(item,config);item.tab.textContent=item.title;load(item);}
  selected=item.key;if(root.hidden){focusBefore=document.activeElement;foreground=true;root.hidden=false;onOpenChange(true);}
  if(!item.frame&&!item.embeddable)load(item);else draw();if(focus)leave.focus();return true;
 }
 function dispose(item){clearTimeout(item.timer);if(item.frame){item.frame.onload=null;item.frame.onerror=null;item.frame.src='about:blank';}item.windowWidth=null;item.holder.remove();item.tab.remove();}
 function closeEntry(key){const item=entries.get(key);if(!item)return;finishResize({cancel:true,announce:false});const wasSelected=selected===key,hadFocus=root.contains(document.activeElement);entries.delete(key);dispose(item);if(!entries.size){hide();return;}if(wasSelected){selected=entries.keys().next().value;maximized=false;}draw();if(wasSelected&&hadFocus&&foreground)leave.focus();}
 function hide(){selected=null;maximized=false;root.hidden=true;root.inert=false;applyLayout();onOpenChange(false);if(foreground&&focusBefore?.isConnected&&focusBefore.getClientRects().length)focusBefore.focus();focusBefore=null;}
 function clear(){if(root.hidden&&!entries.size)return;finishResize({cancel:true,announce:false});for(const item of entries.values())dispose(item);entries.clear();hide();}
 const keydown=event=>{
  if(event.isComposing||!foreground)return;
  if(event.key==='Escape'){handleEscape(event);return;}
  if(event.key!=='Tab')event.stopPropagation();
 };
 root.addEventListener('keydown',keydown);
 const violation=event=>{for(const item of entries.values())if(event.blockedURI===item.url&&event.effectiveDirective==='frame-src'){item.status='Your browser security policy blocked this frame. Open the site separately.';if(selected===item.key)draw();}};document.addEventListener('securitypolicyviolation',violation);
 return {open,close:closeEntry,clear,isOpen:()=>!root.hidden,hasFocus:()=>root.contains(document.activeElement),keys:()=>[...entries.keys()],windowState,setForeground,setMaximized,handleEscape,refreshLayout:resizeViewport,reconcile(valid){const keys=new Set(valid);for(const key of entries.keys())if(!keys.has(key))closeEntry(key);},destroy(){clear();destroyed=true;view?.removeEventListener?.('blur',blur);view?.removeEventListener?.('resize',resizeViewport);view?.visualViewport?.removeEventListener('resize',resizeViewport);document.removeEventListener('securitypolicyviolation',violation);root.removeEventListener('keydown',keydown);root.replaceChildren();}};
}
