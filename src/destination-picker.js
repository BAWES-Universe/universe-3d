// Destination selectors consume the authorized room directory and local entries API only.
import {ENTRY_KEY_RE} from './arrivals.js';
const ROOM_ID_RE=/^[A-Za-z0-9_-]{1,80}$/;
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
const option=(value,label)=>{const node=el('option','',label);node.value=value;return node;};

export function destinationRoomsFromWorlds(worlds=[],universes=[]){
 const universeNames=new Map(universes.map(universe=>[universe.id,universe.name]));
 return worlds.flatMap(world=>(world.rooms||[]).map(room=>({id:room.id,name:room.name,label:[universeNames.get(world.universeId||world.universe_id),world.name,room.name||room.id].filter(Boolean).join(' / ')})));
}
export function readDestinationEntries(value,roomId){
 if(value?.roomId!==roomId||!Array.isArray(value.entries))throw Error('The destination list belongs to another room. Choose the room again.');
 const seen=new Set();return value.entries.map(entry=>{
  if(!entry||typeof entry.key!=='string'||!ENTRY_KEY_RE.test(entry.key)||seen.has(entry.key)||typeof entry.name!=='string'||typeof entry.areaId!=='string')throw Error('The destination returned an invalid arrival list.');
  seen.add(entry.key);return {key:entry.key,areaId:entry.areaId,name:entry.name,isDefault:entry.isDefault===true};
 });
}
export function createDestinationEntryLoader({api}){
 const pending=new Map();
 return roomId=>{
  if(typeof roomId!=='string'||!ROOM_ID_RE.test(roomId))return Promise.reject(Error('Choose a valid destination room.'));
  if(!pending.has(roomId)){
   const request=Promise.resolve().then(()=>api('/api/rooms/'+encodeURIComponent(roomId)+'/entries')).then(value=>readDestinationEntries(value,roomId));
   pending.set(roomId,request);request.finally(()=>{if(pending.get(roomId)===request)pending.delete(roomId);}).catch(()=>{});
  }
  return pending.get(roomId);
 };
}

/** getRooms returns only already-authorized {id,name,label?} room records.
 * getValue/onChange use {target,entry?}; an omitted entry requests default arrival.
 * isCurrent binds this view to the owning room, selected item, and draft identity.
 */
export function mountDestinationPicker({root,api,loadEntries=createDestinationEntryLoader({api}),getRooms,getValue,onChange,isCurrent=()=>true,isEnabled=()=>true,keyPrefix='destination'}){
 let disposed=false,requestEpoch=0;
 root.classList.add('destination-picker');
 const roomLabel=el('label','field');roomLabel.append(el('span','','Destination room'));const rooms=el('select');rooms.dataset.focusKey=keyPrefix+':target';rooms.ariaLabel='Destination room';roomLabel.append(rooms);
 const entryLabel=el('label','field');entryLabel.append(el('span','','Arrival'));const entries=el('select');entries.dataset.focusKey=keyPrefix+':entry';entries.ariaLabel='Destination arrival';entryLabel.append(entries);
 const hint=el('p','panel-hint destination-hint');hint.setAttribute('aria-live','polite');const retry=el('button','small-btn','Retry arrivals');retry.type='button';retry.hidden=true;retry.ariaLabel='Reload destination arrivals';root.append(roomLabel,entryLabel,hint,retry);
 const authorized=()=>{const seen=new Set();return (getRooms?.()||[]).filter(room=>room&&typeof room.id==='string'&&ROOM_ID_RE.test(room.id)&&!seen.has(room.id)&&seen.add(room.id));};
 const current=()=>!disposed&&root.isConnected&&isCurrent();
 const setAvailable=(node,value)=>{node.dataset.unavailable=String(!value);node.disabled=!value||!isEnabled();};
 function keepSelection(value,message){entries.replaceChildren(option('','Default arrival'));if(value.entry)entries.append(option(value.entry,message||'Saved entry: '+value.entry));entries.value=value.entry||'';}
 async function refresh(){
  retry.hidden=true;const epoch=++requestEpoch,value={...getValue()},catalog=authorized();rooms.replaceChildren(option('','Choose a room'));
  for(const room of catalog)rooms.append(option(room.id,room.label||room.name||room.id));
  const available=catalog.some(room=>room.id===value.target);
  if(value.target&&!available)rooms.append(option(value.target,'Unavailable room: '+value.target));rooms.value=value.target||'';setAvailable(rooms,true);
  keepSelection(value);setAvailable(entries,false);
  if(!available){hint.textContent=value.target?'This saved destination is unavailable. Choose a room you can access.':'Choose a room to see its arrivals.';return;}
  hint.textContent='Loading arrivals…';
  try{
   const list=await loadEntries(value.target);
   if(!current()||epoch!==requestEpoch||getValue().target!==value.target||getValue().entry!==value.entry||!authorized().some(room=>room.id===value.target))return;
   entries.replaceChildren(option('','Default arrival'));
   for(const entry of list)entries.append(option(entry.key,(entry.name||entry.key)+' · '+entry.key+(entry.isDefault?' (default)':'')));
   const missing=value.entry&&!list.some(entry=>entry.key===value.entry);
   if(missing)entries.append(option(value.entry,'Saved entry: '+value.entry+' (unavailable)'));entries.value=value.entry||'';setAvailable(entries,true);
   hint.textContent=missing?'This saved entry is unavailable. Travel will use the room’s default arrival.':list.length?'Default arrival lets the destination room choose.':'This room uses its default arrival.';
  }catch(error){if(!current()||epoch!==requestEpoch)return;hint.textContent=error.message||'Arrivals could not load. Try again.';setAvailable(entries,false);retry.hidden=false;setAvailable(retry,true);}
 }
 rooms.onchange=()=>{if(!current()||!isEnabled())return;const target=rooms.value;if(!authorized().some(room=>room.id===target)){refresh();return;}if(target===getValue().target){refresh();return;}onChange({target});if(current())refresh();};
 entries.onchange=()=>{if(!current()||!isEnabled()||entries.disabled||getValue().target!==rooms.value)return;if(!authorized().some(room=>room.id===rooms.value)){refresh();return;}const entry=entries.value;if(entry&&!ENTRY_KEY_RE.test(entry))return;onChange({target:rooms.value,...(entry?{entry}:{})});};
 retry.onclick=()=>{if(current()&&isEnabled())refresh();};
 refresh();return {refresh,destroy(){disposed=true;requestEpoch++;rooms.onchange=null;entries.onchange=null;retry.onclick=null;}};
}
