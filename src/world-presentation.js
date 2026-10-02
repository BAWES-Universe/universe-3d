/** Presentation-only gate. It owns no RAF, timers, transport or application state.
 * Callers keep their normal clock/lifecycle running while the world draw sleeps.
 * No elapsed time is accumulated: first resume snaps to the latest actor state.
 */
export function createWorldPresentation() {
 let suspended=false,resumePending=false,skippedFrames=0,resumeCount=0;
 return {
  setSuspended(value){
   const next=!!value;if(next===suspended)return false;
   suspended=next;if(!next){resumePending=true;resumeCount++;}return true;
  },
  isSuppressed:()=>suspended||resumePending,
  nextFrame(dt,actualDt=dt){
   if(suspended){skippedFrames++;return null;}
   const resumed=resumePending;resumePending=false;
   return {resumed,dt:resumed?0:Math.min(.1,Math.max(0,Number.isFinite(dt)?dt:0)),actualDt:resumed?0:Math.max(0,Number.isFinite(actualDt)?actualDt:0)};
  },
  snapshot:()=>({suspended,resumePending,skippedFrames,resumeCount}),
 };
}
