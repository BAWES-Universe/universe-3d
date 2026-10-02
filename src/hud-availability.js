import {isSidePanel} from './viewport-framing.js';
import {measuredRectangles} from './panel-occlusion.js';

/** A horizontal control lane, independent of the renderer's projection. Panels
 * may overlap, move sides or animate; use their measured union, not URL widths. */
export function availableHudLane({width,height,panels=[]}){
 const spans=panels.filter(r=>isSidePanel(r,width,height)).map(r=>({left:Math.max(0,r.left),right:Math.min(width,r.right)})).sort((a,b)=>a.left-b.left);
 let cursor=0,best={left:0,right:0};
 for(const span of [...spans,{left:width,right:width}]){
  if(span.left-cursor>best.right-best.left)best={left:cursor,right:span.left};
  cursor=Math.max(cursor,span.right);
 }
 return {...best,width:Math.max(0,best.right-best.left),constrained:spans.length>0};
}

const cameraFocusRows=new WeakSet();
function bindCameraFocusReveal(root){
 const row=root.querySelector('#view-controls');if(!row||cameraFocusRows.has(row))return;cameraFocusRows.add(row);
 row.addEventListener('focusin',event=>{
  const control=event.target.closest?.('button');
  if(!control||!row.contains(control)||!control.matches(':focus-visible'))return;
  const css=row.ownerDocument.defaultView.getComputedStyle(row);
  if(css.display!=='flex'||css.flexDirection!=='row'||css.overflowX!=='auto'||row.clientWidth<=0||row.scrollWidth<=row.clientWidth)return;
  // Chromium may leave a partly clipped focused button unmoved. Reveal only
  // this named row, by the minimum horizontal distance; never move focus.
  const r=row.getBoundingClientRect(),b=control.getBoundingClientRect(),inset=5;
  if(![r.left,r.right,b.left,b.right].every(Number.isFinite))return;
  const delta=b.left<r.left+inset?b.left-r.left-inset:b.right>r.right-inset?b.right-r.right+inset:0;
  const bounded=Math.max(-row.scrollLeft,Math.min(row.scrollWidth-row.clientWidth-row.scrollLeft,delta));
  if(Number.isFinite(bounded)&&bounded)row.scrollBy({left:bounded,behavior:'instant'});
 });
}

/** Called before the existing render, so camera occlusion sees final HUD bounds.
 * Binds one focus-visible reveal for the horizontal camera row. The frame update
 * does not scroll; neither path changes focus, input, world, canvas or camera. */
export function createHudAvailability(root,canvas){
 bindCameraFocusReveal(root);
 let previous='';
 return ()=>{
  const {width,height}=canvas.getBoundingClientRect();if(!width||!height)return;
  const lane=availableHudLane({width,height,panels:measuredRectangles('.embedded-panel, .resident-panel',canvas)});
  const values=[lane.left,width-lane.right,lane.width,lane.constrained,lane.width<760,height<540];
  const key=values.join(':');if(key===previous)return;previous=key;
  root.style.setProperty('--hud-left',`${values[0]}px`);
  root.style.setProperty('--hud-right',`${values[1]}px`);
  root.style.setProperty('--hud-width',`${values[2]}px`);
  root.dataset.hudConstrained=String(values[3]);root.dataset.hudCompact=String(values[4]);root.dataset.hudShort=String(values[5]);root.dataset.hudNarrow=String(lane.constrained&&lane.width<320);
 };
}
