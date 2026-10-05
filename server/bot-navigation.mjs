/** Native-3D ground-plane navigation. Original local implementation; no provider. */
import {CATALOG,contains,collisionBoxes} from '../src/worlds.js';
import {objectFootprint} from '../src/personal-area-policy.js';
import {terrainCollisionBoxes} from '../src/terrain.js';
export const BOT_BODY_RADIUS = .34;
export const distance = (a,b) => Math.hypot(a.x-b.x,a.z-b.z);
export function navigationPolicy(scene, config, {returnFrom = null} = {}) {
  // Personal/tag-restricted areas are never implicitly granted to synthetic
  // residents. Explicit restricted areas are an additional deny-only policy.
  const restricted = new Set(config.restrictedAreaIds ?? []);
  const zones = (scene.areas ?? []).filter(a => restricted.has(a.id) || a.personalArea || (a.allowedTags?.length));
  const colliders=[...(scene.objects??[]).flatMap(o=>['image','composition'].includes(o.type)?collisionBoxes(scene,o):CATALOG[o.type]?.solid?[objectFootprint(o)]:[]),...terrainCollisionBoxes(scene.terrain)];
  // Coarse broad phase avoids rescanning all furniture for each swept sample.
  const buckets=new Map(),large=[],cell=4,key=(x,z)=>`${x},${z}`;
  for(const box of colliders){
    const minX=Math.floor((box.x-box.width/2-BOT_BODY_RADIUS)/cell),maxX=Math.floor((box.x+box.width/2+BOT_BODY_RADIUS)/cell),minZ=Math.floor((box.z-box.depth/2-BOT_BODY_RADIUS)/cell),maxZ=Math.floor((box.z+box.depth/2+BOT_BODY_RADIUS)/cell);
    if((maxX-minX+1)*(maxZ-minZ+1)>64){large.push(box);continue;}
    for(let x=minX;x<=maxX;x++)for(let z=minZ;z<=maxZ;z++){const k=key(x,z);if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(box);}
  }
  const blocked=point=>large.some(o=>contains(o,point.x,point.z,BOT_BODY_RADIUS))||(buckets.get(key(Math.floor(point.x/cell),Math.floor(point.z/cell)))??[]).some(o=>contains(o,point.x,point.z,BOT_BODY_RADIUS));
  const radius = returnFrom ? Math.max(config.radius, distance(returnFrom,config.spawn)) : config.radius;
  return point => Math.abs(point.x)<=scene.bounds.width/2-BOT_BODY_RADIUS && Math.abs(point.z)<=scene.bounds.depth/2-BOT_BODY_RADIUS
    && !blocked(point)
    && distance(point,config.spawn) <= radius + 1e-7
    && !zones.some(a => contains(a,point.x,point.z,BOT_BODY_RADIUS));
}
export function segmentClear(a,b,allowed) {
  const steps=Math.max(1,Math.ceil(distance(a,b)/.08));
  for(let i=0;i<=steps;i++)if(!allowed({x:a.x+(b.x-a.x)*i/steps,z:a.z+(b.z-a.z)*i/steps}))return false;
  return true;
}
class Heap {
  a=[];
  push(n){let i=this.a.length;this.a.push(n);while(i){const p=(i-1)>>1;if(this.a[p].f<=n.f)break;this.a[i]=this.a[p];i=p;}this.a[i]=n;}
  pop(){const root=this.a[0],last=this.a.pop();if(this.a.length){let i=0;while(i*2+1<this.a.length){let c=i*2+1;if(c+1<this.a.length&&this.a[c+1].f<this.a[c].f)c++;if(this.a[c].f>=last.f)break;this.a[i]=this.a[c];i=c;}this.a[i]=last;}return root;}
}
/** Bounded A*, exact endpoint connectors, conservative edges, visibility smoothing.
 * null means unreachable (including work budget); [] means already at target. */
export function planBotPath(scene,start,end,config,{returning=false,maxNodes=16000}={}) {
  const allowed=navigationPolicy(scene,config,{returnFrom:returning?start:null});
  if(!allowed(start)||!allowed(end))return null;
  if(distance(start,end)<.001)return [];
  if(segmentClear(start,end,allowed))return [{...end}];
  const step=.5,key=(x,z)=>`${x},${z}`,coords=k=>{const [x,z]=k.split(',').map(Number);return{x:x*step,z:z*step};};
  const open=new Heap(),best=new Map(),came=new Map(),closed=new Set();
  const sx=Math.round(start.x/step),sz=Math.round(start.z/step);
  for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++){
    const x=sx+dx,z=sz+dz,p={x:x*step,z:z*step},k=key(x,z);
    if(!segmentClear(start,p,allowed))continue;
    const g=distance(start,p);best.set(k,g);came.set(k,null);open.push({x,z,k,g,f:g+distance(p,end)});
  }
  let visited=0,found=null;
  while(open.a.length&&visited++<maxNodes){
    const q=open.pop();if(closed.has(q.k))continue;closed.add(q.k);const p={x:q.x*step,z:q.z*step};
    if(distance(p,end)<=.9&&segmentClear(p,end,allowed)){found=q.k;break;}
    for(const[dx,dz]of[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
      const x=q.x+dx,z=q.z+dz,k=key(x,z),p2={x:x*step,z:z*step};if(closed.has(k))continue;
      const g=q.g+Math.hypot(dx,dz)*step;if(g>=(best.get(k)??Infinity))continue;
      if(!segmentClear(p,p2,allowed))continue;
      best.set(k,g);came.set(k,q.k);open.push({x,z,k,g,f:g+distance(p2,end)});
    }
  }
  if(found===null)return null;
  const raw=[{...end}];for(let k=found;k!==null;k=came.get(k))raw.unshift(coords(k));
  const smooth=[];let anchor=start,i=0;
  while(i<raw.length){let next=i;while(next+1<raw.length&&segmentClear(anchor,raw[next+1],allowed))next++;smooth.push(raw[next]);anchor=raw[next];i=next+1;}
  return smooth;
}
