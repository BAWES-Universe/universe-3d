// Credentials live only inside this cache, never in policy, snapshots or diagnostics.
const TIMEOUT_MS=8000, MAX_TTL_MS=14400000;
const validURL=value=>typeof value==='string'&&/^(stun|stuns|turn|turns):[^\s/@#]+$/.test(value);
export function createIceCache({api,env,now,isCurrent,onRenew,onFailure,nextId}){
  let cached=null,inFlight=null,renewTimer=null,expiryTimer=null,epoch=0;
  const elapsed=()=>env.performance?.now?.()??now();
  const key=context=>JSON.stringify([context.roomId,context.selfId,context.scope,context.generation,context.authority]);
  function clearTimers(){if(renewTimer!==null)env.clearTimeout(renewTimer);if(expiryTimer!==null)env.clearTimeout(expiryTimer);renewTimer=expiryTimer=null;}
  function retire(){epoch++;clearTimers();cached=null;const old=inFlight;inFlight=null;old?.cancel?.();}
  function current(context){return isCurrent(context)&&context.scope&&cached?.key===key(context)&&elapsed()<cached.deadline;}
  function configuration(context){return current(context)?{iceServers:cached.servers.map(s=>({...s,urls:[...s.urls]}))}:null;}
  async function ensure(context,renew=false){
    if(!context.scope)return {iceServers:[]}; // Legacy/unconfigured host-only policy; no external defaults.
    if(!isCurrent(context))throw Error('ICE request retired');
    if(!renew&&current(context))return configuration(context);
    if(inFlight?.key===key(context))return inFlight.promise;
    if(inFlight)retire();
    const request={key:key(context),epoch,requestId:nextId(),start:elapsed(),promise:null};inFlight=request;
    request.promise=(async()=>{
      const Controller=env.AbortController||globalThis.AbortController,controller=Controller?new Controller():null;let timer;
      try{
        const deadline=new Promise((_,reject)=>{request.cancel=()=>{controller?.abort();reject(Error('ICE request retired'));};timer=env.setTimeout(()=>{controller?.abort();reject(Error('ICE request timed out'));},TIMEOUT_MS);});
        const result=await Promise.race([api('/api/media/ice',{method:'POST',body:{scope:context.scope,requestId:request.requestId},signal:controller?.signal}),deadline]);
        if(request.epoch!==epoch||!isCurrent(context))throw Error('ICE request retired');
        const delay=elapsed()-request.start;
        if(delay>=TIMEOUT_MS)throw Error('ICE request timed out');
        if(!result||result.scope!==context.scope||result.requestId!==request.requestId||result.selfId!==context.selfId||result.roomId!==context.roomId||!Number.isSafeInteger(result.issuedAt)||!Number.isSafeInteger(result.expiresAt)||!Number.isSafeInteger(result.renewAt)||result.expiresAt<=result.issuedAt||result.expiresAt-result.issuedAt>MAX_TTL_MS||result.renewAt<=result.issuedAt||result.renewAt>=result.expiresAt||!Array.isArray(result.iceServers)||result.iceServers.length>2)throw Error('Invalid ICE response');
        const servers=result.iceServers.map(server=>{
          if(!server||!Array.isArray(server.urls)||!server.urls.length||server.urls.length>8||server.urls.some(url=>!validURL(url)))throw Error('Invalid ICE response');
          const relay=server.urls.some(url=>/^turns?:/.test(url));
          if(relay&&(typeof server.username!=='string'||server.username.length>200||typeof server.credential!=='string'||server.credential.length>512||server.credentialType!=='password'))throw Error('Invalid ICE response');
          return {urls:[...server.urls],...(relay?{username:server.username,credential:server.credential,credentialType:'password'}:{})};
        });
        const remaining=result.expiresAt-result.issuedAt-delay,renewIn=result.renewAt-result.issuedAt-delay;
        if(remaining<=0)throw Error('ICE response expired');
        clearTimers();cached={key:request.key,servers,transport:servers.some(s=>s.urls.some(url=>/^turns?:/.test(url)))?'relay-configured':servers.length?'stun-configured':'host-only',deadline:elapsed()+remaining};
        expiryTimer=env.setTimeout(()=>{if(request.epoch===epoch){retire();onFailure('ICE authorization expired. Devices and connections were stopped; join audio again to retry.');}},remaining);
        renewTimer=env.setTimeout(()=>{if(request.epoch!==epoch||!isCurrent(context))return;void ensure(context,true).then(config=>{if(request.epoch===epoch&&isCurrent(context))onRenew(config);}).catch(()=>{if(request.epoch===epoch&&isCurrent(context)){retire();onFailure('ICE renewal failed. Devices and connections were stopped; join audio again to retry.');}});},Math.max(0,renewIn));
        return configuration(context);
      }finally{if(timer!==undefined)env.clearTimeout(timer);if(inFlight===request)inFlight=null;}
    })();return request.promise;
  }
  return {configuration,ensure,retire,transport:context=>current(context)?cached.transport:null};
}
