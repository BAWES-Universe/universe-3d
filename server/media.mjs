import {SILENT_MEDIA_MESSAGE} from '../src/media-policy-copy.js';
import * as v from './validation.mjs';
const inside=(a,p)=>Number.isFinite(a.x)&&Number.isFinite(a.z)&&Math.abs(p.x-a.x)<=a.width/2&&Math.abs(p.z-a.z)<=a.depth/2;
export function createMediaPolicy({store,presence,emitUser,now}) {
  const enabled=new Map(),priorEdges=new Set();
  const key=(a,b)=>[a,b].sort().join(':');
  function context(p) {
    const room=store.room(p.roomId,p.userId),areas=(room.scene.areas||[]).filter(a=>inside(a,p));
    const a=areas.find(a=>a.action==='silent')||areas.find(a=>a.action==='stage'||a.action==='audience')||areas.find(a=>a.action==='meeting');
    if(a?.action==='silent')return {kind:'silent',label:a.name||'Quiet area',canPublish:false,reason:SILENT_MEDIA_MESSAGE,group:a.id};
    if(a?.action==='stage'){const canPublish=['owner','admin','editor','moderator'].includes(room.role);return {kind:'stage',label:a.name||'Stage',canPublish,reason:canPublish?'Stage speakers can broadcast':'The room owner must grant editor or moderator access to speak on stage',group:a.meetingName||a.id};}
    if(a?.action==='audience')return {kind:'audience',label:a.name||'Audience',canPublish:false,reason:'Audience listens to stage speakers',group:a.meetingName||a.id};
    if(a?.action==='meeting')return {kind:'meeting',label:a.name||'Meeting',canPublish:true,reason:'Everyone in this meeting area can talk',group:a.meetingName||a.id};
    return {kind:'proximity',label:'Nearby conversation',canPublish:!['busy','dnd','invisible'].includes(p.status),reason:['busy','dnd','invisible'].includes(p.status)?'Nearby calls are paused for your current status':p.moving?'Stop near someone to start a conversation':'Nearby stationary players can talk',group:'proximity'};
  }
  function graph(roomId) {
    const players=[...presence.values()].filter(p=>p.roomId===roomId&&store.canSeeRoom(store.roomRow(roomId),p.userId)&&now()-p.lastSeen<60000&&enabled.get(p.userId)===roomId).sort((a,b)=>a.userId.localeCompare(b.userId));
    const contexts=new Map(players.map(p=>[p.userId,context(p)]));const links=new Map(players.map(p=>[p.userId,[]]));
    const edges=[];
    for(let i=0;i<players.length;i++)for(let j=i+1;j<players.length;j++){
      const a=players[i],b=players[j],ac=contexts.get(a.userId),bc=contexts.get(b.userId),pair=key(a.userId,b.userId);
      if(ac.kind==='silent'||bc.kind==='silent')continue;
      let sendA=false,sendB=false,priority=0;
      if(ac.kind==='proximity'&&bc.kind==='proximity'){
        if(!ac.canPublish||!bc.canPublish)continue;
        const distance=Math.hypot(a.x-b.x,a.z-b.z),existed=priorEdges.has(pair);
        if(distance>(existed?6:4)||(!existed&&(a.moving||b.moving)))continue;
        sendA=sendB=true;priority=distance;
      }else if(ac.kind==='meeting'&&bc.kind==='meeting'&&ac.group===bc.group){sendA=sendB=true;}
      else if(['stage','audience'].includes(ac.kind)&&['stage','audience'].includes(bc.kind)&&ac.group===bc.group){sendA=ac.kind==='stage'&&ac.canPublish;sendB=bc.kind==='stage'&&bc.canPublish;}
      if(sendA||sendB)edges.push({a,b,ac,bc,pair,sendA,sendB,priority});
    }
    edges.sort((a,b)=>a.priority-b.priority||a.pair.localeCompare(b.pair));
    const active=new Set(),groups=new Map(players.map(p=>[p.userId,new Set([p.userId])]));
    for(const edge of edges){const{a,b,ac,bc,pair,sendA,sendB}=edge;if(ac.kind==='proximity'){const merged=new Set([...groups.get(a.userId),...groups.get(b.userId)]);if(merged.size>4)continue;for(const id of merged)groups.set(id,merged);}
      active.add(pair);links.get(a.userId).push({id:b.userId,displayName:b.name,name:b.name,canSend:sendA,canReceive:sendB});links.get(b.userId).push({id:a.userId,displayName:a.name,name:a.name,canSend:sendB,canReceive:sendA});
    }
    for(const pair of [...priorEdges])if(players.some(p=>pair.includes(p.userId)))priorEdges.delete(pair);for(const pair of active)priorEdges.add(pair);
    return {links,contexts};
  }
  function policy(userId,roomId) {
    if(!roomId)return {selfId:userId,roomId:null,enabled:false,context:{kind:'none',label:'Outside a room',canPublish:false,reason:'Join a room first'},peers:[],iceServers:[]};
    store.authorize(roomId,userId);const p=presence.get(`${roomId}:${userId}`);const g=graph(roomId);
    return {selfId:userId,roomId,enabled:enabled.get(userId)===roomId,context:p?context(p):{kind:'none',label:'Offline',canPublish:false,reason:'Waiting for player presence'},peers:g.links.get(userId)||[],iceServers:[],limits:{proximityParticipants:4,joinDistance:4,leaveDistance:6}};
  }
  function refresh(roomId) {if(!roomId)return;for(const p of presence.values())if(p.roomId===roomId&&store.canSeeRoom(store.roomRow(roomId),p.userId))emitUser(p.userId,'media-policy',policy(p.userId,roomId));}
  function state(userId,roomId,value) {v.boolean(value,'enabled');if(!roomId)v.fail(403,'JOIN_REQUIRED');store.authorize(roomId,userId);if(value)enabled.set(userId,roomId);else {enabled.delete(userId);for(const pair of [...priorEdges])if(pair.includes(userId))priorEdges.delete(pair);}refresh(roomId);return policy(userId,roomId);}
  function leave(userId,roomId){if(enabled.get(userId)===roomId)enabled.delete(userId);for(const pair of [...priorEdges])if(pair.includes(userId))priorEdges.delete(pair);refresh(roomId);}
  function signal(userId,roomId,b) {
    v.record(b);if(b.roomId!==undefined&&b.roomId!==roomId)v.fail(403,'ROOM_MISMATCH','Signal belongs to a different room');const to=v.id(b.to,'to');const current=policy(userId,roomId),peer=current.peers.find(p=>p.id===to);
    if(!peer)v.fail(403,'MEDIA_FORBIDDEN','This peer is not eligible for media in your current area');
    const payload={from:userId,roomId,connectionId:v.text(b.connectionId,'connectionId',120)};
    if(b.description!==undefined){const d=v.record(b.description,'description');v.oneOf(d.type,['offer','answer'],'description type');v.text(d.sdp,'sdp',64000);const sdp=d.sdp;
      // Validate every transceiver section: absent direction means sendrecv in SDP.
      const sections=sdp.split(/(?=^m=)/m).filter(p=>/^m=(audio|video)\s/m.test(p));
      for(const section of sections){const dir=section.match(/^a=(sendrecv|sendonly|recvonly|inactive)\r?$/m)?.[1]||'sendrecv';if(!peer.canSend&&['sendrecv','sendonly'].includes(dir))v.fail(403,'MEDIA_DIRECTION_FORBIDDEN','Your role is receive-only');if(!peer.canReceive&&['sendrecv','recvonly'].includes(dir))v.fail(403,'MEDIA_DIRECTION_FORBIDDEN','This link is send-only');}
      payload.description={type:d.type,sdp};
    }else if(b.candidate!==undefined){if(b.candidate!==null)v.record(b.candidate,'candidate');v.safeJson(b.candidate,{maxBytes:12000,maxDepth:4});payload.candidate=b.candidate;
    }else if(b.request!==undefined){payload.request=v.oneOf(b.request,['offer','restart'],'request');}
    else v.fail(400,'INVALID_SIGNAL','Supply description, candidate or request');
    emitUser(to,'media-signal',payload);return {ok:true};
  }
  return {policy,refresh,state,leave,signal};
}
