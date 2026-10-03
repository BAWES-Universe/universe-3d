/** Maximized content covers lower game surfaces without disabling higher dialogs.
 * This controller changes only inert flags; history, focus, camera and media stay
 * with their existing owners. Original flags are restored when the cover ends. */
export function createContentWindowModality({getWindow,setForeground,getCoveredElements,hasHigherSurface=()=>false}){
 const previous=new Map();let syncing=false;
 function restore(node,value){if(node.inert!==value)node.inert=value;}
 function sync(){
  if(syncing)return;syncing=true;
  try{
   const window=getWindow?.();const covered=!!window?.open&&!!window.maximized;
   setForeground?.(!hasHigherSurface());
   const elements=new Set(covered?(getCoveredElements?.()||[]).filter(Boolean):[]);
   for(const[node,value]of previous)if(!elements.has(node)){restore(node,value);previous.delete(node);}
   for(const node of elements){if(!previous.has(node))previous.set(node,!!node.inert);if(node.inert!==true)node.inert=true;}
  }finally{syncing=false;}
 }
 return {sync,destroy(){for(const[node,value]of previous)restore(node,value);previous.clear();}};
}
