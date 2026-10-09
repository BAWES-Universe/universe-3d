import {randomUUID} from 'node:crypto';
import {fail} from './validation.mjs';

export const PUBLIC_GUEST_TTL_MS=24*60*60*1000;
export const PUBLIC_GUEST_LIMIT=512;
export const publicGuestsEnabled=config=>config.mode==='public'&&config.registrationMode==='open'&&config.setupOnly===false;
export function requireGuestAccount(){fail(403,'GUEST_ACCOUNT_REQUIRED','Create an account or sign in to save or create. You can keep exploring and talking in public rooms as a guest.');}

// Process-local visitors never enter the SQLite user/account/session tables.
// A restart forgets every guest; registered-account persistence is unchanged.
export function initializePublicGuests(store){
 store.publicGuestProfiles=new Map();store.publicGuestSessions=new Map();store.publicGuestModeration=new Map();
}
export const publicGuestMethods={
 isPublicGuest(id){return this.publicGuestProfiles.has(id);},
 createPublicGuest(name,woka){
  if(this.publicGuestProfiles.size>=PUBLIC_GUEST_LIMIT)fail(503,'GUEST_LIMIT_REACHED','The visitor space is full. Please try again shortly or sign in.');
  const id=randomUUID();
  this.publicGuestProfiles.set(id,{id,name:name||`Guest ${id.slice(0,4)}`,woka,status:'online',created_at:this.now(),expires_at:this.now()+PUBLIC_GUEST_TTL_MS});
  return this.user(id);
 },
 expiredPublicGuests(){return [...this.publicGuestProfiles.values()].filter(g=>g.expires_at<=this.now()||![...this.publicGuestSessions.values()].some(s=>s.user_id===g.id&&s.expires_at>this.now())).map(g=>g.id);},
 deletePublicGuest(id){
  if(!this.isPublicGuest(id))return;
  this.publicGuestProfiles.delete(id);
  for(const[token,s]of this.publicGuestSessions)if(s.user_id===id)this.publicGuestSessions.delete(token);
  for(const[key,m]of this.publicGuestModeration)if(m.user_id===id)this.publicGuestModeration.delete(key);
 },
};
export function sessionPrincipal(store,token,at=store.now(),active=true){
 const guest=store.publicGuestSessions?.get(token);
 if(guest)return !active||guest.expires_at>at?{...guest}:undefined;
 return active?store.get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?',token,at):store.get('SELECT * FROM sessions WHERE token_hash=?',token);
}
export function sessionPrincipals(store,{userId,roomId,exceptToken,joined=false,active=true,at=store.now()}={}){
 const where=[],args=[];
 if(userId!==undefined){where.push('user_id=?');args.push(userId);}
 if(roomId!==undefined){where.push('current_room_id=?');args.push(roomId);}
 if(exceptToken!==undefined){where.push('token_hash!=?');args.push(exceptToken);}
 if(joined)where.push('current_room_id IS NOT NULL');
 if(active){where.push('expires_at>?');args.push(at);}
 const accounts=store.all('SELECT * FROM sessions'+(where.length?' WHERE '+where.join(' AND '):''),...args);
 const guests=[...(store.publicGuestSessions?.values()??[])].filter(s=>(userId===undefined||s.user_id===userId)&&(roomId===undefined||s.current_room_id===roomId)&&(exceptToken===undefined||s.token_hash!==exceptToken)&&(!joined||s.current_room_id!==null)&&(!active||s.expires_at>at)).map(s=>({...s}));
 return [...accounts,...guests];
}
export function moveSession(store,token,roomId){
 const guest=store.publicGuestSessions?.get(token);
 if(guest){guest.current_room_id=roomId;return;}
 store.run('UPDATE sessions SET current_room_id=? WHERE token_hash=?',roomId,token);
}
export function deleteSession(store,token){
 if(store.publicGuestSessions?.delete(token))return;
 store.run('DELETE FROM sessions WHERE token_hash=?',token);
}
export function hasRoomSession(store,userId,roomId,at=store.now(),exceptToken=null){
 if([...(store.publicGuestSessions?.values()??[])].some(s=>s.user_id===userId&&s.current_room_id===roomId&&s.expires_at>at&&s.token_hash!==exceptToken))return true;
 return !!store.get('SELECT 1 FROM sessions WHERE user_id=? AND current_room_id=? AND expires_at>? AND token_hash!=?',userId,roomId,at,exceptToken??'');
}
// Public-room rendering does not require account names or membership metadata.
export function publicGuestPerson(person,selfId){
 const result={};
 for(const key of ['id','userId','name','woka','appearance','status','roomId','x','y','z','direction','rotation','moving','running','velocity','grounded','verticalVelocity','seatId','seatHeight','emote','emoteAt'])if(Object.hasOwn(person,key))result[key]=person[key];
 if((person.id??person.userId)===selfId)for(const key of ['admissionId','admissionEpoch','admissionRevision'])if(Object.hasOwn(person,key))result[key]=person[key];
 return result;
}

// Fail closed for future routes too. Each allowed write is ephemeral or resolves
// an already-saved action. Normal room/admission checks still apply.
export function assertPublicGuestRequest(method,path){
 if(['GET','POST'].includes(method)&&/^\/api\/rooms\/[A-Za-z0-9_-]+\/bots\/[A-Za-z0-9_-]+\/chat$/.test(path))return;
 if(method==='POST'&&(['/api/presence','/api/logout','/api/media/state','/api/media/ice','/api/media/signal','/api/proximity-controls/action','/api/proximity-text/messages','/api/proximity-text/typing'].includes(path)||/^\/api\/rooms\/[A-Za-z0-9_-]+\/(?:join|leave|actions\/resolve|expression|emote)$/.test(path)))return;
 if(method==='GET'&&(
  ['/api/session','/api/users','/api/worlds','/api/universes','/api/discover','/api/memberships','/api/invitations','/api/stars','/api/conversations','/api/quests','/api/media','/api/proximity-controls','/api/proximity-text','/api/events'].includes(path)||
  /^\/api\/(?:universes|worlds)\/[A-Za-z0-9_-]+$/.test(path)||
  /^\/api\/rooms\/[A-Za-z0-9_-]+(?:\/(?:entries|messages|expressions|bot-permissions|personal-areas|files\/[A-Za-z0-9_-]+|assets\/[A-Za-z0-9_-]+\/versions\/[A-Za-z0-9_-]+\/image))?$/.test(path)
 ))return;
 requireGuestAccount();
}
