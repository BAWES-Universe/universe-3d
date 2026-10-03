/** Native one-metre ground cells. Coordinates are WORLD lower corners, not
 * furniture centres. Terrain values are replace-only: edits return a fresh,
 * deeply frozen value; JSON imports/reloads must likewise replace the value.
 * This lets movement reuse a weak identity index without stale edit geometry. */
export const TERRAIN_MATERIALS = Object.freeze(['grass','soil','stone','wood','water']);
export const MAX_TERRAIN_CELLS = 4096;
const MATERIALS = new Set(TERRAIN_MATERIALS), indexes = new WeakMap();
const invalid = message => {const error = new Error(message);error.code='INVALID_TERRAIN';throw error;};
const integer = value => Number.isSafeInteger(value);
const key = (x,z) => `${x},${z}`;
const record = value => value && typeof value==='object' && !Array.isArray(value);

/** Validate without normalizing or mutating input. Undefined is legacy base. */
export function validateTerrain(terrain,bounds){
 if(terrain===undefined)return terrain;
 if(!record(terrain)||Object.keys(terrain).some(k=>!['version','cells'].includes(k))||terrain.version!==1||!Array.isArray(terrain.cells))invalid('Terrain must contain version 1 and a cells array');
 if(terrain.cells.length>MAX_TERRAIN_CELLS)invalid(`Use at most ${MAX_TERRAIN_CELLS.toLocaleString('en-US')} terrain cells`);
 if(bounds!==undefined&&(!record(bounds)||!Number.isFinite(bounds.width)||!Number.isFinite(bounds.depth)||bounds.width<=0||bounds.depth<=0))invalid('Terrain requires valid room bounds');
 const seen=new Set();
 for(const cell of terrain.cells){
  if(!Array.isArray(cell)||cell.length!==4||!integer(cell[0])||!integer(cell[1])||!MATERIALS.has(cell[2])||typeof cell[3]!=='boolean')invalid('Each terrain cell must be [integer x, integer z, material, boolean blocked]');
  const [x,z]=cell,k=key(x,z);if(seen.has(k))invalid('Terrain cell coordinates must be unique');seen.add(k);
  if(bounds&&(x < -bounds.width/2||z < -bounds.depth/2||x+1 > bounds.width/2||z+1 > bounds.depth/2))invalid('Keep every full terrain cell inside the room');
 }
 return terrain;
}

export function terrainCell(point){
 if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.z))invalid('Choose a finite ground point');
 const cell={x:Math.floor(point.x),z:Math.floor(point.z)};
 if(!integer(cell.x)||!integer(cell.z))invalid('Ground coordinates are outside the supported range');
 return cell;
}

/** Inclusive rectangle of integer lower-corner cells, in either drag direction. */
export function terrainRect(fromCell,toCell){
 if(!fromCell||!toCell||![fromCell.x,fromCell.z,toCell.x,toCell.z].every(integer))invalid('Choose integer terrain cell coordinates');
 return{minX:Math.min(fromCell.x,toCell.x),minZ:Math.min(fromCell.z,toCell.z),maxX:Math.max(fromCell.x,toCell.x),maxZ:Math.max(fromCell.z,toCell.z)};
}

/** Paint/repaint atomically; erase returns the original room floor underneath. */
export function applyTerrainRect(terrain,rect,{material,blocked,erase=false}={}){
 validateTerrain(terrain);
 if(!rect||![rect.minX,rect.minZ,rect.maxX,rect.maxZ].every(integer)||rect.minX>rect.maxX||rect.minZ>rect.maxZ)invalid('Choose a valid terrain rectangle');
 if(typeof erase!=='boolean'||!erase&&(!MATERIALS.has(material)||typeof blocked!=='boolean'))invalid('Choose a terrain material and an explicit blocked setting');
 const inside=([x,z])=>x>=rect.minX&&x<=rect.maxX&&z>=rect.minZ&&z<=rect.maxZ;
 const cells=(terrain?.cells??[]).filter(cell=>!inside(cell)).map(cell=>[...cell]);
 if(!erase){
  const count=(rect.maxX-rect.minX+1)*(rect.maxZ-rect.minZ+1);
  if(!Number.isSafeInteger(count)||count+cells.length>MAX_TERRAIN_CELLS)invalid(`Use at most ${MAX_TERRAIN_CELLS.toLocaleString('en-US')} terrain cells`);
  for(let z=rect.minZ;z<=rect.maxZ;z++)for(let x=rect.minX;x<=rect.maxX;x++)cells.push([x,z,material,blocked]);
 }
 cells.sort((a,b)=>a[1]-b[1]||a[0]-b[0]);
 return Object.freeze({version:1,cells:Object.freeze(cells.map(cell=>Object.freeze(cell)))});
}

export function terrainCollisionBoxes(terrain){
 return(terrain?.cells??[]).filter(cell=>cell[3]).map(([x,z])=>({x:x+.5,z:z+.5,width:1,depth:1}));
}

function terrainIndex(terrain){
 let index=indexes.get(terrain);if(index)return index;
 validateTerrain(terrain);index=new Set();
 for(const [x,z,,blocked]of terrain.cells)if(blocked)index.add(key(x,z));
 indexes.set(terrain,index);return index;
}

/** Conservative square body overlap, matching furniture collision, inclusive
 * at the boundary. After first indexing, only nearby cells are examined. */
export function terrainBlocks(scene,x,z,r=.3){
 const terrain=scene?.terrain;if(terrain===undefined)return false;
 if(!Number.isFinite(x)||!Number.isFinite(z)||!Number.isFinite(r)||r<0)return true;
 const index=terrainIndex(terrain);
 const minX=Math.ceil(x-r)-1,maxX=Math.floor(x+r),minZ=Math.ceil(z-r)-1,maxZ=Math.floor(z+r);
 if(![minX,maxX,minZ,maxZ].every(integer))return true;
 if((maxX-minX+1)*(maxZ-minZ+1)>MAX_TERRAIN_CELLS){for(const k of index){const [cx,cz]=k.split(',').map(Number);if(cx>=minX&&cx<=maxX&&cz>=minZ&&cz<=maxZ)return true;}return false;}
 for(let cz=minZ;cz<=maxZ;cz++)for(let cx=minX;cx<=maxX;cx++)if(index.has(key(cx,cz)))return true;
 return false;
}
