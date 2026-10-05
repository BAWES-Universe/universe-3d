/** Compatibility declarations are per request/tab, never an authorization grant. */
export const IMAGE_PHYSICAL_SIZE_CAPABILITY='image-physical-size-v1';
export const COMPOSITION_FURNITURE_CAPABILITY='composition-furniture-v1';
const CAPABILITIES=IMAGE_PHYSICAL_SIZE_CAPABILITY+','+COMPOSITION_FURNITURE_CAPABILITY;
export const CLIENT_CAPABILITIES_HEADER='X-Universe-Client-Capabilities';
export const clientProtocolHeaders=(initial={})=>({...initial,[CLIENT_CAPABILITIES_HEADER]:CAPABILITIES});
export function clientEventsUrl(path='/api/events'){
 const separator=path.includes('?')?'&':'?';
 return path+separator+'capabilities='+encodeURIComponent(CAPABILITIES);
}
export function normalizeClientProtocol(data){
 const value=data?.imagePhysicalSize??data;
 return {enabled:value?.enabled===true,required:value?.required===true,capability:typeof value?.capability==='string'?value.capability:IMAGE_PHYSICAL_SIZE_CAPABILITY};
}
export const supportsClientProtocol=policy=>!policy.required||policy.capability===IMAGE_PHYSICAL_SIZE_CAPABILITY;
export function isClientReloadRequired(data){
 return data?.code==='CLIENT_RELOAD_REQUIRED'||data?.error==='CLIENT_RELOAD_REQUIRED'||data?.error?.code==='CLIENT_RELOAD_REQUIRED';
}
export function reportClientReloadRequired(data){
 if(isClientReloadRequired(data)&&typeof globalThis.dispatchEvent==='function'&&typeof CustomEvent==='function')globalThis.dispatchEvent(new CustomEvent('universe-client-reload-required',{detail:data}));
}
export function clientReloadError(reason){
 const error=new Error(reason||'Reload this page to use the current room format. Export unsaved work first.');
 error.status=426;error.code='CLIENT_RELOAD_REQUIRED';error.data={error:error.code,code:error.code,message:error.message};return error;
}
/** A late successful response cannot reactivate a tab after its protocol retires. */
export function createClientProtocolGuard(onRetire=()=>{}){
 let retired=null,generation=0;
 return {
  capture:()=>generation,
  isRetired:()=>retired!==null,
  reason:()=>retired?.message??null,
  assertCurrent(captured=generation){if(retired||captured!==generation)throw clientReloadError(retired?.message);},
  retire(data={}){
   if(retired)return false;
   retired=clientReloadError(typeof data.message==='string'?data.message:typeof data.reason==='string'?data.reason:undefined);
   generation++;onRetire(retired);return true;
  }
 };
}
