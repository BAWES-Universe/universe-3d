import {validateEntryKey} from './arrivals.js';
// Shared authoring/runtime contract. Ordered arrays are authoritative when present.
// Legacy scene properties remain available for export and old scene compatibility.
export const ACTION_TYPES = Object.freeze(['message','link','audio','teleport']);
export const MAX_ACTIONS = 20;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SENSITIVE_QUERY = /^(?:access_token|refresh_token|id_token|token|authorization|password|secret|api_?key|session)$/i;
export function safeActionUrl(value,baseOrigin) {
 if(typeof value!=='string'||!value||value.length>2048||value!==value.trim()||CONTROL.test(value)||/\\/.test(value))return null;
 try{
  let local=value.startsWith('/')&&!value.startsWith('//');
  if(!local&&!/^https?:\/\//i.test(value))return null;
  const parsed=new URL(value,'https://room.invalid');
  if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)return null;
  if(!local&&baseOrigin&&parsed.origin===new URL(baseOrigin).origin)return safeActionUrl(parsed.pathname+parsed.search+parsed.hash);
  for(const key of [...parsed.searchParams.keys(),...new URLSearchParams(parsed.hash.slice(1)).keys()])if(SENSITIVE_QUERY.test(key))return null;
  let kind='external';
  if(local){
   // Do not let encoded path separators or dot segments smuggle an API path.
   if(/%(?:2e|2f|5c|00|0a|0d)/i.test(value)||value.split(/[?#]/)[0].split('/').some(v=>v==='.'||v==='..'))return null;
   const document=/^\/api\/rooms\/[A-Za-z0-9_-]{1,80}\/files\/[A-Za-z0-9_-]{1,80}$/.test(parsed.pathname);
   if(parsed.pathname.startsWith('/api')&&!document)return null;
   if(document&&(parsed.search||parsed.hash))return null;
   kind=document?'document':'asset';
  }
  return {url:value,kind,protocol:parsed.protocol};
 }catch{return null;}
}
export function actionName(action){return action.name||action.label||({message:'Read message',link:'Open website',audio:'Play sound',teleport:'Travel to room'})[action.type]||'Action';}
export function createAction(type,id){
 if(!ACTION_TYPES.includes(type)||!ID.test(id))throw new Error('Choose a supported action and unique ID');
 const base={id,type,name:actionName({type}),description:'',trigger:'interact'};
 if(type==='message')return {...base,message:'A new message'};
 if(type==='link')return {...base,url:'https://example.com',label:'Open website',mode:'tab',width:60,closable:true};
 if(type==='audio')return {...base,url:'/assets/chime.wav',label:'Play sound',volume:.5,loop:true};
 return {...base,target:'commons'};
}
export function itemActions(item){
 if(Array.isArray(item?.actions))return item.actions;
 const result=[];
 if(item?.target)result.push({id:'legacy-target',type:'teleport',name:'Travel to room',description:'',target:item.target,...(item.entry!==undefined?{entry:item.entry}:{})});
 if(item?.url)result.push({id:'legacy-url',type:'link',name:item.document?'Download '+item.document.name:'Open website',description:'',url:item.url,label:item.document?'Download document':'Open website',mode:'tab',width:60,closable:true});
 return result;
}
export function materializeItemActions(item){if(!Array.isArray(item.actions))item.actions=itemActions(item).map(action=>({...action}));return item.actions;}
export function validateActions(actions,{scope='area'}={}){
 const invalid=message=>{throw new Error(message);};
 const text=(v,label,max)=>{if(typeof v!=='string'||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))invalid(`${label} must be text up to ${max} characters`);};
 if(!Array.isArray(actions)||actions.length>MAX_ACTIONS)invalid(`Actions must contain at most ${MAX_ACTIONS} actions`);
 const ids=new Set();
 for(const action of actions){
  if(!action||typeof action!=='object'||Array.isArray(action))invalid('Action must be an object');
  if(typeof action.id!=='string'||!ID.test(action.id)||ids.has(action.id))invalid('Action IDs must be valid and unique within their item or area');ids.add(action.id);
  if(scope==='area'&&/^legacy-area-(?:link|target|message)$/.test(action.id))invalid('This action ID is reserved for legacy area behavior');
  if(!ACTION_TYPES.includes(action.type))invalid('Unsupported action type');
  const fields=['id','type','name','description','trigger',...(action.type==='message'?['message']:action.type==='link'?['url','label','mode','width','closable']:action.type==='audio'?['url','label','volume','loop']:['target','entry'])];
  if(Object.keys(action).some(key=>!fields.includes(key)))invalid('Unsupported action field');
  for(const [key,max]of [['name',120],['description',1000],['label',120],['message',2000]])if(action[key]!==undefined)text(action[key],`Action ${key}`,max);
  if(['link','audio'].includes(action.type)&&!safeActionUrl(action.url))invalid('Action URL must use safe HTTP(S), a local asset, or a protected room document; credentials are not allowed');
  if(action.type==='audio'&&safeActionUrl(action.url)?.kind==='document')invalid('Room documents are downloads, not playable audio');
  if(action.type==='teleport'&&(typeof action.target!=='string'||!ID.test(action.target)))invalid('Choose a valid destination room ID');
  if(action.entry!==undefined)validateEntryKey(action.entry);
  if(action.trigger!==undefined&&(!['interact','enter'].includes(action.trigger)||(scope==='item'&&action.trigger!=='interact')))invalid('Items require deliberate activation; area triggers must be interact or enter');
  if(action.mode!==undefined&&!['tab','embed'].includes(action.mode))invalid('Link mode must be tab or embed');
  if(action.width!==undefined&&(typeof action.width!=='number'||!Number.isFinite(action.width)||action.width<30||action.width>90))invalid('Panel width must be between 30 and 90 percent');
  if(action.closable!==undefined&&typeof action.closable!=='boolean')invalid('Closable must be true or false');
  if(action.volume!==undefined&&(typeof action.volume!=='number'||!Number.isFinite(action.volume)||action.volume<0||action.volume>1))invalid('Sound volume must be between 0 and 1');
  if(action.loop!==undefined&&typeof action.loop!=='boolean')invalid('Loop must be true or false');
  if(action.type==='link'&&safeActionUrl(action.url)?.kind==='document'&&action.mode==='embed')invalid('Protected room documents must open as downloads');
 }
 return actions;
}
