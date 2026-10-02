import {randomUUID}from'node:crypto';import*as v from'./validation.mjs';
const inside=(a,p)=>Math.abs(p.x-a.x)<=a.width/2&&Math.abs(p.z-a.z)<=a.depth/2;
/** Bounded room-visible expressions. Ephemeral, not persistent or proximity chat. */
export function createExpressionService({store,presence,emitRoom,now=Date.now,limit}){
 const thoughts=new Map(),operations=new Map();
 function clear(roomId,userId){const key=roomId+':'+userId;if(!thoughts.delete(key))return false;emitRoom(roomId,'expression-clear',{roomId,userId,kind:'think'});return true;}
 function post(roomId,userId,activeRoomId,body){
  const auth=store.authorize(roomId,userId);if(activeRoomId!==roomId||!presence.has(roomId+':'+userId))v.fail(403,'JOIN_REQUIRED','Enter this room before expressing yourself');
  if(auth.member?.muted_until>now())v.fail(403,'MUTED','A moderator has paused your room messages');
  const requested=v.oneOf(body.kind,['say','think'],'expression kind'),text=v.text(body.text,'expression',100),operation=body.clientOperationId==null?null:v.id(body.clientOperationId,'clientOperationId');
  const operationKey=userId+':'+operation,previous=operation&&operations.get(operationKey),signature=JSON.stringify([roomId,requested,text]);
  if(previous&&previous.expires>now()){if(previous.signature!==signature)v.fail(409,'OPERATION_REUSED','This expression ID was already used');return{expression:previous.expression,duplicate:true};}
  limit('expression:'+userId,30);const person=store.user(userId),position=presence.get(roomId+':'+userId),scene=store.room(roomId,userId).scene;
  const silent=(scene.areas||[]).some(a=>a.action==='silent'&&inside(a,position));const kind=silent||['away','busy','dnd','invisible'].includes(person.status)?'think':requested;
  if(kind==='say')clear(roomId,userId);
  const expression={id:randomUUID(),roomId,userId,author:{id:userId,name:person.name,woka:person.woka,appearance:person.appearance,status:person.status},kind,text,createdAt:now(),...(kind==='say'?{expiresAt:now()+5000}:{}),origin:{x:position.x,z:position.z}};
  if(kind==='think')thoughts.set(roomId+':'+userId,expression);
  if(operation)operations.set(operationKey,{signature,expression,expires:now()+120000});
  if(operations.size>1000)for(const[key,entry]of operations)if(entry.expires<now())operations.delete(key);
  emitRoom(roomId,'expression',{roomId,expression});return{expression};
 }
 function list(roomId,userId,activeRoomId){store.authorize(roomId,userId);if(activeRoomId!==roomId)v.fail(403,'JOIN_REQUIRED');return{roomId,thoughts:[...thoughts.values()].filter(e=>e.roomId===roomId&&presence.has(roomId+':'+e.userId))};}
 function movement(roomId,userId,before,after){if(before&&after&&(after.moving||Math.hypot((after.x??0)-(before.x??0),(after.z??0)-(before.z??0))>.02))clear(roomId,userId);}
 function prune(){for(const[key,item]of thoughts)if(!presence.has(item.roomId+':'+item.userId))clear(item.roomId,item.userId);for(const[key,item]of operations)if(item.expires<=now())operations.delete(key);}
 return{post,list,clear,movement,prune};
}
