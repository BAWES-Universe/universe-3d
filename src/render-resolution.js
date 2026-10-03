// One render pixel per CSS pixel, independent of device DPR. Supersampling is
// intentionally off: bound fill work to 1080p for the world and 512² for preview.
// These are framebuffer budgets, not claims about hardware frame rate or memory.
export const WORLD_RENDER_PIXELS=1920*1080;
export const PREVIEW_RENDER_PIXELS=512*512;

export function renderHardwareScale(width,height,maxPixels){
  return Math.max(1,Math.sqrt(Math.max(0,width)*Math.max(0,height)/maxPixels));
}

export function resizeRenderBuffer(engine,canvas,maxPixels){
  const scale=renderHardwareScale(canvas.clientWidth,canvas.clientHeight,maxPixels);
  // Changing Babylon's hardware scale resizes already. Resize explicitly when
  // only the CSS dimensions changed, including while a surface was hidden.
  if(engine.getHardwareScalingLevel()!==scale)engine.setHardwareScalingLevel(scale);
  else engine.resize();
}
