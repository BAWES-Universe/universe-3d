// CSS-pixel geometry only. The Babylon viewport and camera pose stay untouched.
const finite=Number.isFinite;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export function clippedRectangle(rect,width,height,padding=0){
 if(!rect||![rect.left,rect.top,rect.right,rect.bottom,width,height].every(finite)||width<=0||height<=0)return null;
 const left=clamp(rect.left-padding,0,width),top=clamp(rect.top-padding,0,height),right=clamp(rect.right+padding,0,width),bottom=clamp(rect.bottom+padding,0,height);
 return right>left&&bottom>top?{left,top,right,bottom,width:right-left,height:bottom-top}:null;
}
export function isSidePanel(rect,width,height){
 const r=clippedRectangle(rect,width,height);if(!r)return false;
 // Mobile full-screen sheets and centered dialogs have no side-map contract.
 if(r.width>=width*.92&&r.height>=height*.92)return false;
 return Math.min(r.left,width-r.right)<=Math.max(32,width*.04);
}
/** Exact largest empty axis-aligned rectangle. Boundaries lie on viewport or
 * obstacle edges; each x strip's union of y intervals gives every candidate.
 * A fit constraint is tested independently in each dimension, never by area. */
export function largestFreeRectangle({width,height,obstacles=[],padding=0,minWidth=0,minHeight=0}){
 if(!finite(width)||!finite(height)||width<=0||height<=0)return null;
 const blocks=obstacles.map(r=>clippedRectangle(r,width,height,padding)).filter(Boolean),xs=[...new Set([0,width,...blocks.flatMap(r=>[r.left,r.right])])].sort((a,b)=>a-b);
 let best=null;
 function consider(left,right,top,bottom){const w=right-left,h=bottom-top;if(w<=0||h<=0||w+1e-6<minWidth||h+1e-6<minHeight)return;const area=w*h,centerDistance=((left+right-width)/2)**2+((top+bottom-height)/2)**2;if(!best||area>best.area+1e-6||Math.abs(area-best.area)<1e-6&&centerDistance<best.centerDistance)best={left,top,right,bottom,width:w,height:h,area,centerDistance};}
 for(let a=0;a<xs.length-1;a++)for(let b=a+1;b<xs.length;b++){
  if(xs[b]-xs[a]+1e-6<minWidth)continue;
  const spans=blocks.filter(r=>r.left<xs[b]&&r.right>xs[a]).sort((x,y)=>x.top-y.top);let top=0;
  for(const r of spans){if(r.top>top)consider(xs[a],xs[b],top,r.top);top=Math.max(top,r.bottom);if(top>=height)break;}
  if(top<height)consider(xs[a],xs[b],top,height);
 }
 return best;
}
export function frameInFreeArea({width,height,panels=[],hud=[],footprint,padding=12}){
 const sidePanels=panels.filter(r=>isSidePanel(r,width,height));
 if(!sidePanels.length)return {status:'unobstructed',offset:{x:0,y:0},rect:{left:0,top:0,right:width,bottom:height,width,height},panelCount:0};
 const obstacles=[...sidePanels,...hud],minWidth=footprint.right-footprint.left+2*padding,minHeight=footprint.bottom-footprint.top+2*padding;
 const rect=largestFreeRectangle({width,height,obstacles,padding,minWidth,minHeight});
 if(!rect)return {status:'insufficient-space',offset:null,rect:largestFreeRectangle({width,height,obstacles,padding}),panelCount:sidePanels.length,minWidth,minHeight};
 return {status:'framed',offset:{x:(rect.left+rect.right-footprint.left-footprint.right)/2,y:(rect.top+rect.bottom-footprint.top-footprint.bottom)/2},rect,panelCount:sidePanels.length,minWidth,minHeight};
}
export function createFramingTransition(duration=.5){
 let value={x:0,y:0},start={...value},goal={...value},elapsed=duration;
 return {step(next,dt,{manual=false}={}){if(manual){start={...value};goal={...value};elapsed=duration;return {...value};}if(next&&(Math.abs(next.x-goal.x)>.05||Math.abs(next.y-goal.y)>.05)){start={...value};goal={...next};elapsed=0;}elapsed=Math.min(duration,elapsed+Math.max(0,dt));const t=duration?elapsed/duration:1,ease=1-(1-t)**2;value={x:start.x+(goal.x-start.x)*ease,y:start.y+(goal.y-start.y)*ease};return {...value};},get:()=>({...value})};
}
// Row-vector LH perspective: clip.w is view.z. Adding to m[8]/m[9]
// translates NDC without changing scale, yaw, pitch, distance or ray geometry.
export function projectionShift(offset,width,height){return {x:width>0?2*offset.x/width:0,y:height>0?-2*offset.y/height:0};}
