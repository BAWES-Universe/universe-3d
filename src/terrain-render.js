// Terrain stays a sparse set of authored one-metre cells. These helpers only
// prepare render geometry; the shared terrain model owns validation/collision.
const EPSILON=1e-8;
export const TERRAIN_SURFACES=Object.freeze({
 grass:{tint:'#d0dabc',height:.04},soil:{tint:'#c5b19a',height:.04},
 stone:{tint:'#ddd8bd',height:.04},wood:{tint:'#d1b8a0',height:.04},
 water:{tint:'#b5ddd2',height:.024}
});
function mergeRuns(runs){
 const rectangles=[],active=new Map();
 for(const {z0,z1,spans} of runs){
  const next=new Map();
  for(const [x0,x1] of spans){
   const key=x0+':'+x1,previous=active.get(key);
   const rectangle=previous&&Math.abs(previous.z1-z0)<EPSILON?previous:{x0,x1,z0,z1};
   if(rectangle===previous)rectangle.z1=z1;else rectangles.push(rectangle);
   next.set(key,rectangle);
  }
  active.clear();for(const [key,value]of next)active.set(key,value);
 }
 return rectangles;
}
function intervals(xs){
 const sorted=[...new Set(xs)].sort((a,b)=>a-b),result=[];
 for(const x of sorted){const last=result.at(-1);if(last&&last[1]===x)last[1]=x+1;else result.push([x,x+1]);}
 return result;
}
export function createTerrainMask(terrain){
 const rows=new Map();for(const [x,z]of terrain?.cells||[]){if(!rows.has(z))rows.set(z,[]);rows.get(z).push(x);}
 return new Map([...rows].sort(([a],[b])=>a-b).map(([z,xs])=>[z,intervals(xs)]));
}
// Exact rectangle subtraction avoids paving, deck fittings and soil remaining
// above a painted pond. Identical adjacent strips become one larger rectangle.
export function subtractTerrainRect(mask,{x,z,width,depth}){
 const x0=x-width/2,x1=x+width/2,z0=z-depth/2,z1=z+depth/2;
 const cuts=new Set([z0,z1]);
 for(const [row,spans]of mask){if(row>=z1||row+1<=z0||!spans.some(([a,b])=>a<x1&&b>x0))continue;cuts.add(Math.max(z0,row));cuts.add(Math.min(z1,row+1));}
 const zs=[...cuts].sort((a,b)=>a-b),runs=[];
 for(let i=0;i<zs.length-1;i++){
  const lo=zs[i],hi=zs[i+1],spans=[];let cursor=x0;
  for(const [a,b]of mask.get(Math.floor((lo+hi)/2))||[]){if(b<=cursor||a>=x1)continue;if(a>cursor+EPSILON)spans.push([cursor,Math.min(a,x1)]);cursor=Math.max(cursor,b);if(cursor>=x1)break;}
  if(cursor<x1-EPSILON)spans.push([cursor,x1]);runs.push({z0:lo,z1:hi,spans});
 }
 return mergeRuns(runs).map(r=>({x:(r.x0+r.x1)/2,z:(r.z0+r.z1)/2,width:r.x1-r.x0,depth:r.z1-r.z0}));
}
export function terrainOverlapsRect(mask,{x,z,width,depth}){
 const x0=x-width/2,x1=x+width/2,z0=z-depth/2,z1=z+depth/2;
 for(const [row,spans]of mask)if(row<z1-EPSILON&&row+1>z0+EPSILON&&spans.some(([a,b])=>a<x1-EPSILON&&b>x0+EPSILON))return true;
 return false;
}
export function terrainSurfaceGroups(terrain){
 const groups=new Map();
 for(const [x,z,kind]of terrain?.cells||[]){if(!TERRAIN_SURFACES[kind])continue;if(!groups.has(kind))groups.set(kind,new Map());const rows=groups.get(kind);if(!rows.has(z))rows.set(z,[]);rows.get(z).push(x);}
 return [...groups].map(([material,rows])=>({material,rectangles:mergeRuns([...rows].sort(([a],[b])=>a-b).map(([z,xs])=>({z0:z,z1:z+1,spans:intervals(xs)})))}));
}
// One vertex buffer per material, even for a 4096-cell checkerboard. World-space
// UVs retain the original two-metre texture scale across brush/merge boundaries.
export function terrainSurfaceGeometry(rectangles,height=0){
 const positions=[],normals=[],uvs=[],indices=[];
 for(const {x0,x1,z0,z1}of rectangles){
  const start=positions.length/3;
  for(const [x,z]of [[x0,z0],[x0,z1],[x1,z1],[x1,z0]]){positions.push(x,height,z);normals.push(0,1,0);uvs.push(x/2,z/2);}
  // Babylon uses clockwise front faces in its left-handed world.
  indices.push(start,start+2,start+1,start,start+3,start+2);
 }
 return {positions,normals,uvs,indices};
}
export function terrainGhostLines(width,depth,height=.115){
 const x0=-width/2,x1=width/2,z0=-depth/2,z1=depth/2,lines=[];
 for(let x=x0;x<=x1+EPSILON;x+=1)lines.push([[x,height,z0],[x,height,z1]]);
 for(let z=z0;z<=z1+EPSILON;z+=1)lines.push([[x0,height,z],[x1,height,z]]);
 return lines;
}

// Build disconnected cut surfaces directly, without one Babylon mesh per piece.
// Chunks stay within 16-bit indices, including fragmented six-face box borders.
export const TERRAIN_BATCH_VERTEX_LIMIT=60000;
export function* terrainCutGeometry(pieces,height,geometryForPiece){
 let data={positions:[],normals:[],uvs:[],indices:[]};
 for(const piece of pieces){
  const part=geometryForPiece(piece),count=part.positions.length/3;
  if(data.positions.length/3+count>TERRAIN_BATCH_VERTEX_LIMIT){yield data;data={positions:[],normals:[],uvs:[],indices:[]};}
  const start=data.positions.length/3;
  for(let i=0;i<part.positions.length;i+=3)data.positions.push(part.positions[i]+piece.x,part.positions[i+1]+height,part.positions[i+2]+piece.z);
  data.normals.push(...part.normals);data.uvs.push(...part.uvs);
  for(const index of part.indices)data.indices.push(start+index);
 }
 if(data.positions.length)yield data;
}
