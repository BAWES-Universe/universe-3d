// Bounding-box suppression keeps anchored labels off actual interface elements.
// DOM rectangles are viewport-relative, including their CSS transforms and fonts.
export function rectanglesOverlap(a,b,padding=0){return a.left<b.right+padding&&a.right>b.left-padding&&a.top<b.bottom+padding&&a.bottom>b.top-padding;}
export function labelFits(rect,viewport,obstacles,padding=8){
 if(rect.width<=0||rect.height<=0||rect.left<viewport.left+4||rect.right>viewport.right-4||rect.top<viewport.top+4||rect.bottom>viewport.bottom-4)return false;
 return !obstacles.some(obstacle=>rectanglesOverlap(rect,obstacle,padding));
}
export const WORLD_LABEL_OCCLUDERS='#hud > .brand, #hud > .room-heading, #hud > .hud-right, #quest-open, #area-banner, #view-controls, #dock, #interaction, #quick-actions, #shortcuts-help, #toast, #area-sounds, .builder-heading, .builder-toolbelt, .builder-tray, .builder-inspector, .builder-hint, .builder-recovery, #social, #places, #media, #avatar-creator, #command-palette, .quest-sheet, .quest-invitation, .express-tray, .shortcuts-sheet, .modal-backdrop';
