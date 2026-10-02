import {safeActionUrl} from './action-schema.js';
const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
/** Sandboxed provider frames; loading is never asserted to prove provider acceptance. */
export function mountEmbeddedPanels({root,onOpenChange=()=>{},toast=()=>{}}){
 const entries=new Map();let selected=null,focusBefore=null;
 root.className='embedded-overlay';root.hidden=true;
 const panel=element('section','embedded-panel');panel.setAttribute('role','region');panel.setAttribute('aria-label','Room content');
 const header=element('header','embedded-header'),heading=element('strong','', 'Room content'),leave=element('button','small-btn','Return to world');leave.type='button';leave.onclick=()=>clear();
 const tabs=element('div','embedded-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Open room content');
 const status=element('p','embedded-status'),actions=element('div','embedded-actions'),external=element('button','small-btn','Open in new tab ↗'),retry=element('button','small-btn','Reload frame'),close=element('button','small-btn','Close this panel');
 for(const b of[external,retry,close])b.type='button';header.append(heading,leave);actions.append(external,retry,close);const frames=element('div','embedded-frames');panel.append(header,tabs,status,actions,frames);root.append(panel);
 function current(){return entries.get(selected);}
 external.onclick=()=>current()?.onExternal?.();retry.onclick=()=>{const item=current();if(item)load(item);};close.onclick=()=>closeEntry(selected);
 function draw(){
  const item=current();if(!item)return;
  heading.textContent=item.title;status.textContent=item.status;panel.style.setProperty('--content-width',Math.max(30,Math.min(90,item.width??60))+'vw');close.hidden=item.closable===false;retry.disabled=!item.embeddable;
  tabs.replaceChildren();for(const [key,value]of entries){const button=element('button','',value.title);button.type='button';button.setAttribute('role','tab');button.setAttribute('aria-selected',String(key===selected));button.onclick=()=>{selected=key;draw();};tabs.append(button);value.holder.hidden=key!==selected;}
  tabs.hidden=entries.size<2;
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
  frame.onerror=()=>{if(entries.get(item.key)!==item)return;clearTimeout(item.timer);item.status='The site could not be displayed here. Open it in a new tab, or choose Reload frame.';if(selected===item.key)draw();};
  item.holder.append(frame);item.timer=setTimeout(()=>{if(entries.get(item.key)!==item)return;item.status='Still loading, or the site may prohibit embedding. Open in new tab remains available.';if(selected===item.key)draw();},10000);draw();
 }
 function open(config,{focus=true}={}){
  let item=entries.get(config.key);
  if(!item){
   if(entries.size>=5){toast('Close an open content panel before opening another');return false;}
   item={...config,title:config.title||'Room content',holder:element('div','embedded-frame-holder'),status:'Opening content…',frame:null,timer:null};entries.set(item.key,item);frames.append(item.holder);
  }else if(item.url!==config.url){Object.assign(item,config);load(item);}
  selected=item.key;if(root.hidden){focusBefore=document.activeElement;root.hidden=false;onOpenChange(true);}
  if(!item.frame&&!item.embeddable)load(item);else draw();if(focus)leave.focus();return true;
 }
 function dispose(item){clearTimeout(item.timer);if(item.frame){item.frame.onload=null;item.frame.onerror=null;item.frame.src='about:blank';}item.holder.remove();}
 function closeEntry(key){const item=entries.get(key);if(!item)return;entries.delete(key);dispose(item);if(!entries.size){hide();return;}if(selected===key)selected=entries.keys().next().value;draw();leave.focus();}
 function hide(){selected=null;root.hidden=true;onOpenChange(false);if(focusBefore?.isConnected&&focusBefore.getClientRects().length)focusBefore.focus();}
 function clear(){if(root.hidden&&!entries.size)return;for(const item of entries.values())dispose(item);entries.clear();hide();}
 root.addEventListener('keydown',event=>{
  if(event.isComposing)return;
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();clear();return;}
  if(event.key!=='Tab')event.stopPropagation();
 });
 const violation=event=>{for(const item of entries.values())if(event.blockedURI===item.url&&event.effectiveDirective==='frame-src'){item.status='Your browser security policy blocked this frame. Open the site separately.';if(selected===item.key)draw();}};document.addEventListener('securitypolicyviolation',violation);
 return {open,close:closeEntry,clear,isOpen:()=>!root.hidden,hasFocus:()=>root.contains(document.activeElement),keys:()=>[...entries.keys()],reconcile(valid){const keys=new Set(valid);for(const key of entries.keys())if(!keys.has(key))closeEntry(key);},destroy(){clear();document.removeEventListener('securitypolicyviolation',violation);root.replaceChildren();}};
}
