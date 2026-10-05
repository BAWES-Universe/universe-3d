// History stores surface names and an opaque, tab-local content key, never URLs or form data.
const names=new Set(['chat','people','settings','places','quests','build','editor-review','bots','personal','content','avatar','palette','express','images','workshop','dialog']);
export function surfaceLayers(entry,room){
 if(entry?.room!==room)return [];
 return [...new Set([...(Array.isArray(entry.underlay)?entry.underlay:[]),entry.surface].filter(name=>names.has(name)&&name!=='content'))];
}
export function surfaceEntry(current,{room,surface,nested=false,content=null,visible=()=>true}){
 const underlay=nested?surfaceLayers(current,room).filter(name=>name!==surface&&visible(name)):[];
 const entry={room,surface};if(underlay.length)entry.underlay=underlay;if(content)entry.content=content;
 // Embedded content coexists with primary side panels instead of being replaced by them.
 const push=nested||current?.room!==room||!current?.surface||(current.surface==='content'&&!!content);
 // Carry the changed-background boundary through primary and nested surfaces.
 // New layers above that depth may safely Back to their already-updated parent.
 if(!content&&current?.room===room&&Number.isInteger(current.contentDismissedDepth)&&current.contentDismissedDepth>0)entry.contentDismissedDepth=Math.min(current.contentDismissedDepth,underlay.length+1);
 return{entry,method:push?'pushState':'replaceState'};
}
export function createSurfaceHistory({history,getRoom,getContent=()=>null,isVisible=()=>true,getUrl=()=>''}){
 let backPending=false,pending=null,replaying=false;
 const room=()=>getRoom()??null;
 function remember(surface,options={}){
  if(replaying)return;
  if(backPending){pending={surface,options};return;}
  const current=history.state||{},content=getContent();
  // Async reauthorization may open content below a foreground surface during Forward.
  if(surface==='content'&&content&&current.room===room()&&current.content===content)return;
  const next=surfaceEntry(current,{room:room(),surface,...options,content,visible:isVisible});
  if(JSON.stringify(next.entry)===JSON.stringify(current))return;
  history[next.method](next.entry,'',getUrl());
 }
 function forgetContent(key){const current=history.state;if(!current?.content||key&&current.content!==key)return;const next={...current};delete next.content;if(next.surface==='content')delete next.surface;else if(next.surface)next.contentDismissedDepth=surfaceLayers(next,room()).length;history.replaceState(next,'',getUrl());}
 function dismiss(surface){
  if(replaying)return;
  if(history.state?.surface===surface&&!backPending){
   if(history.state.contentDismissedDepth&&surfaceLayers(history.state,room()).length<=history.state.contentDismissedDepth){
    // UI dismissal preserves today's background. Native Back/Forward may still
    // revisit the older authorized content entry, which remains unchanged.
    const layers=surfaceLayers(history.state,room()).filter(name=>name!==surface&&isVisible(name));
    const next={room:room()},content=getContent();if(layers.length){next.surface=layers.pop();if(layers.length)next.underlay=layers;next.contentDismissedDepth=layers.length+1;}if(content)next.content=content;
    history.replaceState(next,'',getUrl());return;
   }
   backPending=true;history.back();
  }
  else if(surface==='content')forgetContent();
 }
 function replay(reconcile){
  backPending=false;
  if(pending){const next=pending;pending=null;remember(next.surface,next.options);}
  replaying=true;try{return reconcile();}finally{replaying=false;}
 }
 return{remember,dismiss,replay,forgetContent,wantsContent:key=>!!key&&history.state?.room===room()&&history.state?.content===key,
  get backPending(){return backPending;},queue:surface=>{pending={surface,options:{}};}};
}
