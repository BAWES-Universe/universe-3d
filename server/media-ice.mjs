import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import * as v from './validation.mjs';

// This adapter configures a transport. It does not provision or verify a relay.
const secrets=new WeakMap();
const MAX_SCOPES=2048, MAX_RATES=4096, RATE_MS=60000;
export const ICE_BODY_LIMIT=1024, ICE_BODY_TIMEOUT_MS=8000;
const failConfig=()=>{throw new Error('Invalid media ICE configuration');};
function urls(value,kind){
  if(value===undefined||value==='')return [];
  if(typeof value!=='string'||value.length>4096)failConfig();
  const list=value.split(',');if(list.length>8)failConfig();
  return [...new Set(list.map(raw=>{
    const text=raw.trim();
    const match=/^(stun|stuns|turn|turns):(?:\[([0-9a-fA-F:]+)\]|([a-zA-Z0-9.-]+))(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/.exec(text);
    if(!match||!match[1].startsWith(kind)||(kind==='stun'&&match[5])||(match[1]==='turns'&&match[5]==='udp'))failConfig();
    const host=match[2]||match[3];
    if(match[2]?isIP(host)!==6:host.length>253||host.split('.').some(label=>!/^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])$/.test(label)))failConfig();
    if(/^\d+\.\d+\.\d+\.\d+$/.test(host)&&isIP(host)!==4)failConfig();
    if(match[4]&&(+match[4]<1||+match[4]>65535))failConfig();
    return text;
  }))];
}
export function readIceRelayConfig(env={}){
  if(!env||typeof env!=='object')failConfig();
  if(env.MEDIA_TURN_USERNAME!==undefined||env.MEDIA_TURN_PASSWORD!==undefined)failConfig();
  const stunUrls=urls(env.MEDIA_STUN_URLS,'stun'),turnUrls=urls(env.MEDIA_TURN_URLS,'turn');
  const secret=env.MEDIA_TURN_SHARED_SECRET;
  if(turnUrls.length?(typeof secret!=='string'||secret.length<32||secret.length>512||/\s|[\x00-\x1f\x7f]/.test(secret)):secret!==undefined&&secret!=='')failConfig();
  const number=(value,fallback)=>{if(value===undefined||value==='')return fallback;if(typeof value!=='string'||!/^\d+$/.test(value))failConfig();return Number(value);};
  const ttlSeconds=number(env.MEDIA_ICE_TTL_SECONDS,14400);
  const renewalSeconds=number(env.MEDIA_ICE_RENEWAL_SECONDS,Math.floor(ttlSeconds*.75));
  if(!Number.isSafeInteger(ttlSeconds)||ttlSeconds<60||ttlSeconds>14400||!Number.isSafeInteger(renewalSeconds)||renewalSeconds<30||renewalSeconds>ttlSeconds-15)failConfig();
  const config=Object.freeze({stunUrls:Object.freeze(stunUrls),turnUrls:Object.freeze(turnUrls),ttlSeconds,renewalSeconds});
  secrets.set(config,secret||null);return config;
}
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function readIceBody(req){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))v.fail(415,'JSON_REQUIRED');
  const length=req.headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>ICE_BODY_LIMIT))v.fail(413,'ICE_BODY_TOO_LARGE');
  const text=await new Promise((resolve,reject)=>{
    let size=0;const chunks=[];
    const cleanup=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('aborted',abort);req.off('error',abort);};
    const fail=(status,code)=>{cleanup();req.resume();reject(Object.assign(new Error(code),{status,code}));};
    const data=chunk=>{size+=chunk.length;if(size>ICE_BODY_LIMIT)return fail(413,'ICE_BODY_TOO_LARGE');chunks.push(chunk);};
    const end=()=>{cleanup();resolve(Buffer.concat(chunks).toString('utf8'));};
    const abort=()=>fail(400,'ICE_BODY_ABORTED');
    const timer=setTimeout(()=>fail(408,'ICE_BODY_TIMEOUT'),ICE_BODY_TIMEOUT_MS);timer.unref?.();
    req.on('data',data);req.on('end',end);req.on('aborted',abort);req.on('error',abort);
  });
  let b;try{b=JSON.parse(text);}catch{v.fail(400,'INVALID_JSON');}v.record(b);
  if(Object.keys(b).length!==2||!Object.hasOwn(b,'scope')||!Object.hasOwn(b,'requestId')||typeof b.scope!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(b.scope)||typeof b.requestId!=='string'||!/^[A-Za-z0-9_-]{16,96}$/.test(b.requestId))v.fail(400,'INVALID_ICE_REQUEST');
  return b;
}
export function createMediaIce({config=readIceRelayConfig({}),store,presence,media,now}){
  if(!secrets.has(config))failConfig();
  const sessions=new Map(),rates=new Map();
  const liveSession=token=>store.get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?',token,now());
  function prune(){
    for(const[token,row]of sessions){const s=liveSession(token),p=presence.get(`${row.roomId}:${row.userId}`);if(!s||s.current_room_id!==row.roomId||!p||now()-p.lastSeen>=60000||!store.canSeeRoom(store.roomRow(row.roomId),row.userId))sessions.delete(token);}
    for(const[k,b]of rates)if(now()-b.start>=RATE_MS)rates.delete(k);
  }
  // Retain rate counters until their bounded window expires: toggling opt-in must not reset limits.
  function retire(token){sessions.delete(token);}
  function retireUser(userId){for(const[token,row]of sessions)if(row.userId===userId)retire(token);}
  function optIn(s,enabled){retire(s.token_hash);if(enabled){prune();if(sessions.size>=MAX_SCOPES)v.fail(503,'ICE_CAPACITY');sessions.set(s.token_hash,{roomId:s.current_room_id,userId:s.user_id,key:null,scope:null});}}
  function allowed(s,p){
    const current=liveSession(s.token_hash),row=sessions.get(s.token_hash),player=presence.get(`${s.current_room_id}:${s.user_id}`);
    return current&&current.user_id===s.user_id&&current.current_room_id===s.current_room_id&&row?.roomId===s.current_room_id&&row.userId===s.user_id&&s.current_room_id&&store.canSeeRoom(store.roomRow(s.current_room_id),s.user_id)&&player&&now()-player.lastSeen<60000&&p?.selfId===s.user_id&&p.roomId===s.current_room_id&&p.enabled===true&&['proximity','meeting','stage','audience'].includes(p.context?.kind)&&!(p.context?.kind==='proximity'&&!p.context.canPublish);
  }
  function decorate(s,p){
    const result={...p,iceRequired:true};delete result.iceScope;
    const row=sessions.get(s.token_hash);
    if(!allowed(s,p)){if(row){row.key=null;row.scope=null;}return result;}
    const key=JSON.stringify([s.user_id,s.current_room_id,p.context.kind,p.context.group,p.context.canPublish]);
    if(row.key!==key){row.key=key;row.scope=randomBytes(32).toString('base64url');}
    result.iceScope=row.scope;return result;
  }
  // Observe every authoritative refresh, even without an SSE subscriber. Leaving
  // and returning to the same context must not resurrect the earlier challenge.
  function observe(userId,p){for(const[token,row]of sessions)if(row.userId===userId){const s=liveSession(token);if(s)decorate(s,p);else retire(token);}}
  function rate(key,max){let b=rates.get(key);if(!b||now()-b.start>=RATE_MS){if(!b&&rates.size>=MAX_RATES)v.fail(503,'ICE_CAPACITY');b={start:now(),n:0};rates.set(key,b);}if(++b.n>max)v.fail(429,'ICE_RATE_LIMITED');}
  function begin(s){prune();rate(`s:${s.token_hash}`,8);rate(`u:${s.user_id}`,20);}
  function issue(s,b){
    const p=decorate(s,media.policy(s.user_id,s.current_room_id));
    if(!p.iceScope||!equal(b.scope,p.iceScope))v.fail(403,'ICE_SCOPE_FORBIDDEN');
    const current=liveSession(s.token_hash),issuedAt=now(),expiresAt=Math.min(Math.floor((issuedAt+config.ttlSeconds*1000)/1000)*1000,Math.floor(current.expires_at/1000)*1000);
    if(expiresAt<=issuedAt+1000)v.fail(401,'ICE_SESSION_EXPIRING');
    const iceServers=config.stunUrls.length?[{urls:[...config.stunUrls]}]:[];
    if(config.turnUrls.length){const username=`${Math.floor(expiresAt/1000)}:${s.user_id}`;iceServers.push({urls:[...config.turnUrls],username,credential:createHmac('sha1',secrets.get(config)).update(username).digest('base64'),credentialType:'password'});}
    return {scope:p.iceScope,requestId:b.requestId,selfId:s.user_id,roomId:s.current_room_id,issuedAt,expiresAt,renewAt:Math.min(issuedAt+config.renewalSeconds*1000,issuedAt+Math.floor((expiresAt-issuedAt)*.75)),transport:config.turnUrls.length?'relay-configured':config.stunUrls.length?'stun-configured':'host-only',iceServers};
  }
  return {decorate,observe,optIn,retire,retireUser,prune,begin,issue};
}
