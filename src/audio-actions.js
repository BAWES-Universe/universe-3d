/** Owned, deduplicated sound lifetimes. Native Audio is injectable only for tests. */
export function createAudioActions({createAudio=url=>new Audio(url),onChange=()=>{},onError=()=>{},initialVolume=1,saveVolume=()=>{}}={}){
 const entries=new Map();let userVolume=clamp(initialVolume),muted=false,ducked=false;
 function clamp(v){return Number.isFinite(Number(v))?Math.max(0,Math.min(1,Number(v))):1;}
 const effective=entry=>muted?0:Math.min(entry.configuredVolume,userVolume)*(ducked?.5:1);
 const publish=()=>onChange(snapshot());
 function snapshot(){return{userVolume,muted,ducked,entries:[...entries.values()].map(e=>({key:e.key,label:e.label,status:e.status,error:e.error,loop:e.audio.loop,configuredVolume:e.configuredVolume,effectiveVolume:effective(e)}))};}
 function dispose(entry){entry.epoch++;entry.audio.onended=null;entry.audio.onerror=null;try{entry.audio.pause();entry.audio.removeAttribute?.('src');entry.audio.src='';entry.audio.load?.();}catch{}}
 function stop(key){const entry=entries.get(key);if(!entry)return;entries.delete(key);dispose(entry);publish();}
 function ensure(config){
  const fingerprint=JSON.stringify([config.url,config.label,config.volume,config.loop]);let entry=entries.get(config.key);
  if(entry&&entry.fingerprint!==fingerprint){stop(config.key);entry=null;}
  if(!entry){
   const audio=createAudio(config.url);audio.crossOrigin='anonymous';audio.preload='none';audio.loop=!!config.loop;
   entry={key:config.key,label:config.label||'World sound',configuredVolume:clamp(config.volume??1),fingerprint,audio,status:'ready',error:'',epoch:0,pending:null};entries.set(entry.key,entry);
   audio.onended=()=>{if(entries.get(entry.key)!==entry)return;entry.status='ended';publish();};
   audio.onerror=()=>{if(entries.get(entry.key)!==entry)return;entry.epoch++;entry.pending=null;entry.status='error';entry.error='Audio could not load. Check the URL and CORS permission, then choose Retry.';onError(entry.error);publish();};
  }
  entry.audio.volume=effective(entry);publish();return entry;
 }
 async function play(configOrKey){
  const entry=typeof configOrKey==='string'?entries.get(configOrKey):ensure(configOrKey);if(!entry)return false;
  if(entry.pending)return entry.pending;if(entry.status==='playing')return true;
  const wasEnded=entry.status==='ended',wasError=entry.status==='error',epoch=++entry.epoch;entry.error='';entry.status='loading';publish();
  const pending=(async()=>{try{
   if(wasError)entry.audio.load?.();if(wasEnded)entry.audio.currentTime=0;
   await entry.audio.play();
   if(entries.get(entry.key)!==entry){try{entry.audio.pause();}catch{}return false;}if(entry.epoch!==epoch)return false;
   entry.status='playing';publish();return true;
  }catch(error){
   if(entries.get(entry.key)!==entry||entry.epoch!==epoch)return false;
   entry.status='error';entry.error=error?.name==='NotAllowedError'?'Playback was blocked. Choose Play to try again.':'Audio could not play. Check the link and CORS permission, then choose Retry.';onError(entry.error);publish();return false;
  }})();
  entry.pending=pending;pending.then(()=>{if(entries.get(entry.key)===entry&&entry.pending===pending)entry.pending=null;});return pending;
 }
 function pause(key){const e=entries.get(key);if(!e)return;e.epoch++;e.pending=null;e.audio.pause();e.status='paused';publish();}
 function updateVolumes(){for(const entry of entries.values())entry.audio.volume=effective(entry);publish();}
 return {ensure,play,pause,stop,snapshot,
  setVolume(value){userVolume=clamp(value);saveVolume(userVolume);updateVolumes();},
  setMuted(value){muted=!!value;updateVolumes();},
  setDucked(value){ducked=!!value;updateVolumes();},
  reconcile(keys){const allowed=new Set(keys);for(const key of entries.keys())if(!allowed.has(key))stop(key);},
  clear(){for(const entry of entries.values())dispose(entry);entries.clear();publish();}
 };
}
