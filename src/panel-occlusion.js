// Only actual side surfaces are blockers. Backdrops, their full-screen wrappers,
// centered dialogs and authoring containers are intentionally absent.
export const SIDE_PANEL_OCCLUDERS='#social, .resident-panel, .embedded-panel';
export function measuredRectangles(selector,canvas,root=document){
 const viewport=canvas.getBoundingClientRect(),rects=[];
 for(const el of root.querySelectorAll(selector)){
  if(el.hidden||el.closest('[hidden]')||!el.getClientRects().length)continue;
  const style=getComputedStyle(el);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)continue;
  const r=el.getBoundingClientRect();if(r.width<=0||r.height<=0)continue;
  rects.push({left:r.left-viewport.left,top:r.top-viewport.top,right:r.right-viewport.left,bottom:r.bottom-viewport.top});
 }
 return rects;
}
const FRAMING_HUD='#hud > .brand, #hud > .room-heading, #hud > .hud-right, #quest-open, #area-banner, #view-controls, #dock, #interaction, #quick-actions, #shortcuts-help, #toast, #area-sounds, .builder-heading, .builder-toolbelt, .builder-tray, .builder-inspector, .builder-hint, .builder-recovery, #media';
// Re-measure every rendered frame so CSS transitions, side changes, panel content
// resizing and visual viewport resizing need no stale fixed-width assumption.
export function measurePanelOcclusion(canvas){return {panels:measuredRectangles(SIDE_PANEL_OCCLUDERS,canvas),hud:measuredRectangles(FRAMING_HUD,canvas)};}
