import {ENTRY_KEY_RE} from './arrivals.js';
import {readTravelLocation,shareDestinationUrl} from './travel-location.js';

const el=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
/** Ordinary destination links never create invitations or membership grants. */
export function createArrivalShare({root,api,getState,openDialog,isOpen,toast=()=>{},getUrl=()=>location.href,clipboard=()=>navigator.clipboard}){
 let sequence=0;
 async function open(){
  const state=getState();if(!state.ready||!state.room||!state.user)return false;
  const actor=state.user.id,roomId=state.room.id,request=++sequence;
  openDialog({owner:'share-arrival',eyebrow:'INVITE SOMEONE IN',title:'Share a room link',text:'Choose where people arrive. A link does not grant access to a private room.'});
  const current=()=>sequence===request&&isOpen()&&getState().ready&&getState().user?.id===actor&&getState().room?.id===roomId;
  const field=el('label','Arrival'),select=el('select');select.setAttribute('aria-label','Arrival for shared link');select.disabled=true;
  const defaultOption=el('option','Default arrival');defaultOption.value='';select.append(defaultOption);field.append(select);
  const output=el('input');output.type='url';output.readOnly=true;output.setAttribute('aria-label','Room destination link');
  const copy=el('button','Copy link');copy.type='button';copy.className='primary';copy.disabled=true;
  const status=el('p','Loading available arrivals…');status.setAttribute('role','status');
  const form=el('div');form.className='arrival-share-form';form.append(field,output,copy,status);root.append(form);let entries=new Set(),loaded=false;
  const update=()=>{const entry=select.value||undefined;if(entry!==undefined&&!entries.has(entry))throw Error('Choose an available arrival.');output.value=shareDestinationUrl(getUrl(),{roomId,...(entry===undefined?{}:{entry})});};
  select.onchange=()=>{if(current()&&loaded){update();status.textContent='';}};
  copy.onclick=async()=>{
   if(!current()||!loaded)return;copy.disabled=true;
   try{update();const text=output.value;const target=clipboard();if(typeof target?.writeText!=='function')throw Error('Clipboard unavailable');await target.writeText(text);if(!current())return;status.textContent='Room link copied.';toast('Room link copied');}
   catch{if(!current())return;output.focus();output.select();status.textContent='Copy this selected link. Private-room access still needs membership.';}
   finally{if(current())copy.disabled=false;}
  };
  try{
   const result=await api('/api/rooms/'+encodeURIComponent(roomId)+'/entries');if(!current())return false;
   if(result.roomId!==roomId||!Number.isSafeInteger(result.revision)||!Array.isArray(result.entries)||result.entries.length>256||result.entries.some(item=>!item||typeof item.key!=='string'||!ENTRY_KEY_RE.test(item.key)||typeof item.name!=='string')||new Set(result.entries.map(item=>item.key)).size!==result.entries.length)throw Error('The arrival list could not be verified.');
   for(const entry of result.entries){entries.add(entry.key);const option=el('option',entry.name+(entry.isDefault?' · default':''));option.value=entry.key;select.append(option);}
   let requested;try{const link=readTravelLocation(getUrl());if(link.roomId===roomId)requested=link.entry;}catch{}
   if(requested&&entries.has(requested))select.value=requested;
   loaded=true;select.disabled=false;copy.disabled=false;update();status.textContent=result.entries.length?'Choose a named arrival or use this room’s defaults.':'This room uses its default arrival.';return true;
  }catch(error){if(current()){status.textContent=error.message||'Available arrivals could not load. Close this window and try again.';select.disabled=copy.disabled=true;}return false;}
 }
 return{open,cancel(){sequence++;}};
}
