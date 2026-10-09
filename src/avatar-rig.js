import {TransformNode} from '@babylonjs/core/Meshes/transformNode.js';
import {Mesh} from '@babylonjs/core/Meshes/mesh.js';
import {VertexData} from '@babylonjs/core/Meshes/mesh.vertexData.js';
import {VertexBuffer} from '@babylonjs/core/Buffers/buffer.js';
import {CreateSphere} from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import {CreateCylinder} from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js';
import {CreateBox} from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import {CreateTorus} from '@babylonjs/core/Meshes/Builders/torusBuilder.js';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial.js';
import {Color3} from '@babylonjs/core/Maths/math.color.js';
import {Vector3} from '@babylonjs/core/Maths/math.vector.js';
import {normalizeAppearance,appearanceKey} from './avatar-spec.js';

const materials=new WeakMap();
function sharedMaterial(scene){
  let mat=materials.get(scene);
  if(!mat||mat.isDisposed?.()){
    mat=new StandardMaterial('universe-avatar-vertex-colors',scene);
    mat.diffuseColor=Color3.White();mat.specularColor=new Color3(.025,.022,.03);mat.specularPower=32;mat.backFaceCulling=true;
    materials.set(scene,mat);
  }
  return mat;
}
const palette={ink:'#252237',cream:'#f5eedf',gold:'#e3b852',sole:'#ece4d5',cheek:'#cf856f'};
const shortestAngle=(a,b)=>Math.atan2(Math.sin(b-a),Math.cos(b-a));

/** All original geometry. +Z is the face/nose direction; feet sit at root y=0.
 * Pieces are baked to vertex colors and merged per moving joint: normally 10
 * draw meshes and ONE scene-shared material, with no per-avatar textures.
 */
export function createAvatarRig(scene,input,options={}){
  const root=new TransformNode(`avatar-${options.id||'preview'}`,scene);
  root.metadata={type:'native-3d-avatar',forwardAxis:'+Z',catalog:'universe-original-v1'};
  const material=sharedMaterial(scene);
  let appearance,appearanceHash,body,head,headGeometry,armL,armR,legL,legR,shinL,shinR,meshes=[],parts=[],phase=0,clock=0,gait=0,lastHeading=0,disposed=false;
  const shadowGenerator=options.shadowGenerator||options.shadows;
  const scale=Number.isFinite(options.scale)?options.scale:1;
  function build(value){
    for(const mesh of meshes)shadowGenerator?.removeShadowCaster?.(mesh);
    for(const node of parts)node.dispose(false,false);
    meshes=[];parts=[];appearance=normalizeAppearance(value);appearanceHash=appearanceKey(appearance);
    const a=appearance,groups=new Map();
    const node=(name,parent=root,x=0,y=0,z=0)=>{const n=new TransformNode(`${root.name}-${name}`,scene);n.parent=parent;n.position.set(x,y,z);parts.push(n);groups.set(n,[]);return n;};
    function colored(mesh,color,parent,x=0,y=0,z=0,rotation){
      mesh.position.set(x,y,z);if(rotation)mesh.rotation.set(...rotation);
      mesh.material=material;mesh.isPickable=false;mesh.metadata={type:'avatar-part',part:mesh.name};
      const c=Color3.FromHexString(color),colors=new Float32Array(mesh.getTotalVertices()*4);
      for(let i=0;i<colors.length;i+=4){colors[i]=c.r;colors[i+1]=c.g;colors[i+2]=c.b;colors[i+3]=1;}
      mesh.setVerticesData(VertexBuffer.ColorKind,colors);groups.get(parent).push(mesh);return mesh;
    }
    const sphere=(name,color,parent,x,y,z,sx,sy,sz,segments=12)=>colored(CreateSphere(name,{diameter:1,segments},scene),color,parent,x,y,z);
    function ellipsoid(name,color,parent,x,y,z,sx,sy,sz,segments=12){const m=sphere(name,color,parent,x,y,z,sx,sy,sz,segments);m.scaling.set(sx,sy,sz);return m;}
    function box(name,color,parent,x,y,z,w,h,d,rotation){return colored(CreateBox(name,{width:w,height:h,depth:d},scene),color,parent,x,y,z,rotation);}
    function cylinder(name,color,parent,x,y,z,top,bottom,height,rotation,tessellation=12){return colored(CreateCylinder(name,{diameterTop:top,diameterBottom:bottom,height,tessellation},scene),color,parent,x,y,z,rotation);}
    function torus(name,color,parent,x,y,z,diameter,thickness,rotation){return colored(CreateTorus(name,{diameter,thickness,tessellation:20},scene),color,parent,x,y,z,rotation);}
    // A rounded, tapered oval loft. Unlike a capsule, this has shoulders, a waist,
    // a flat garment hem, genuine side depth, and deliberate silhouette changes.
    function garment(name,color,parent,x,y,z,rings,width,depth){
      const positions=[],indices=[],normals=[],segments=16;
      for(const [yy,r]of rings)for(let j=0;j<segments;j++){const theta=j/segments*Math.PI*2;positions.push(Math.sin(theta)*width*r,yy,Math.cos(theta)*depth*r);}
      for(let i=0;i<rings.length-1;i++)for(let j=0;j<segments;j++){const p=i*segments+j,q=i*segments+(j+1)%segments;indices.push(p,p+segments,q,q,p+segments,q+segments);}
      const bottom=positions.length/3;positions.push(0,rings[0][0],0);const top=positions.length/3;positions.push(0,rings.at(-1)[0],0);
      for(let j=0;j<segments;j++){indices.push(bottom,j,(j+1)%segments);const p=(rings.length-1)*segments;indices.push(top,p+(j+1)%segments,p+j);}
      VertexData.ComputeNormals(positions,indices,normals);const data=new VertexData();data.positions=positions;data.indices=indices;data.normals=normals;data.uvs=new Float32Array(positions.length/3*2);const m=new Mesh(name,scene);data.applyToMesh(m);return colored(m,color,parent,x,y,z);
    }
    body=node('body');head=node('head',body,0,1.62,0);armL=node('left-arm',body,-.34,1.24,0);armR=node('right-arm',body,.34,1.24,0);
    legL=node('left-leg',body,-.14,.70,0);legR=node('right-leg',body,.14,.70,0);shinL=node('left-shin',legL,0,-.31,0);shinR=node('right-shin',legR,0,-.31,0);
    const width=a.body.build==='slim'?.91:a.body.build==='soft'?1.13:1,height=a.body.height==='petite'?.91:a.body.height==='tall'?1.09:1;
    root.scaling.set(scale*width,scale*height,scale*(a.body.build==='soft'?1.07:1));
    cylinder('neck',a.skin,body,0,1.34,0,.20,.21,.23);
    const topWidth=a.topStyle==='hoodie'?.315:.295,topDepth=a.topStyle==='hoodie'?.195:.168;
    garment('tailored-top',a.topColor,body,0,.73,0,[[0,.88],[.055,1],[.42,1],[.55,.84],[.59,.44]],topWidth,topDepth);
    if(a.topStyle==='jacket'){
      garment('ribbed-jacket-hem',palette.ink,body,0,.735,0,[[0,1],[.064,1]],.265,.172);
      box('jacket-zip',palette.gold,body,0,1.005,.176,.023,.41,.018);
      // A pair of shaped lapels, welt pockets, and a tiny original star badge.
      box('left-lapel',palette.cream,body,-.075,1.235,.153,.095,.15,.03,[0,0,-.29]);
      box('right-lapel',palette.cream,body,.075,1.235,.153,.095,.15,.03,[0,0,.29]);
      box('left-pocket',palette.ink,body,-.166,.92,.158,.112,.018,.022,[0,0,.14]);
      box('right-pocket',palette.ink,body,.166,.92,.158,.112,.018,.022,[0,0,-.14]);
      box('badge-a',palette.gold,body,-.164,1.16,.178,.058,.058,.022,[0,0,Math.PI/4]);
    }else if(a.topStyle==='hoodie'){
      ellipsoid('hood',a.topColor,body,0,1.27,-.14,.45,.36,.24);
      ellipsoid('hood-lining',palette.cream,body,0,1.365,-.11,.28,.15,.18);
      box('hoodie-pocket',a.topColor,body,0,.88,.189,.29,.13,.035);
      for(const x of[-.07,.07]){cylinder('drawstring',palette.cream,body,x,1.16,.187,.013,.013,.16);ellipsoid('toggle',palette.gold,body,x,1.075,.185,.025,.028,.023,6);}
    }else{
      torus('tee-collar',palette.cream,body,0,1.316,0,.20,.024);
      box('tee-universe-mark',palette.gold,body,0,1.09,.172,.085,.085,.018,[0,0,Math.PI/4]);
    }
    // Sculpted head, small protruding nose, ears and four tiny eye highlights.
    ellipsoid('head-volume',a.skin,head,0,0,0,.66,.70,.59,16);

    for(const side of[-1,1]){
      ellipsoid('ear',a.skin,head,side*.327,-.015,-.005,.14,.205,.12);
      ellipsoid('ear-inner',palette.cheek,head,side*.358,-.022,.04,.05,.105,.025,8);
      ellipsoid('eye-white',palette.cream,head,side*.135,.002,.271,.125,.151,.038);
      ellipsoid('iris',a.eyeColor,head,side*.133,-.003,.292,.063,.089,.024,10);
      ellipsoid('pupil',palette.ink,head,side*.133,-.003,.304,.032,.060,.013,8);
      ellipsoid('eye-spark',palette.cream,head,side*.133-.01,.023,.313,.018,.022,.010,6);
      box('brow',a.hairColor,head,side*.139,.115,.268,.115,.025,.030,[0,0,side*-.05]);
      ellipsoid('cheek',palette.cheek,head,side*.224,-.085,.233,.055,.025,.013,8);
    }
    ellipsoid('nose',a.skin,head,0,-.064,.292,.10,.10,.103);
    // Curved smile built from three tiny volumes, visible from the front only.
    for(const [x,y,angle]of[[-.034,-.160,-.20],[0,-.166,0],[.034,-.160,.20]])box('smile',palette.ink,head,x,y,.275,.038,.012,.014,[0,0,angle]);
    if(a.hairStyle!=='bald'){
      // The cap never covers the face; hair has a separately sculpted back.
      garment('hair-crown',a.hairColor,head,0,0,-.024,[[.18,.92],[.29,1],[.36,.75],[.393,.12]],.344,.303);
      ellipsoid('hair-back',a.hairColor,head,0,.14,-.198,.56,.42,.25);
      for(const side of[-1,1])ellipsoid('sideburn',a.hairColor,head,side*.287,.087,-.022,.095,.26,.16);
      if(a.hairStyle==='sweep'){
        const m=ellipsoid('swept-fringe',a.hairColor,head,-.074,.242,.186,.50,.19,.23);m.rotation.z=-.24;
        ellipsoid('swept-lock',a.hairColor,head,-.259,.147,.12,.14,.28,.19);
      }else if(a.hairStyle==='crop'){
        for(const x of[-.22,-.11,0,.11,.22])ellipsoid('crop-fringe',a.hairColor,head,x,.237,.218,.14,.11,.12,8);
      }else if(a.hairStyle==='curls'&&a.hat==='none'){
        for(let i=0;i<11;i++){const theta=i/11*Math.PI*2;ellipsoid('curl',a.hairColor,head,Math.sin(theta)*.29,.28+(i%2)*.045,Math.cos(theta)*.246,.21,.205,.20,8);}
        for(const x of[-.14,.07])ellipsoid('top-curl',a.hairColor,head,x,.385,-.02,.24,.17,.23,8);
      }else if(a.hairStyle==='bob'){
        garment('bob-back',a.hairColor,head,0,0,-.12,[[-.22,1],[-.12,1.07],[.20,1]],.335,.242);
        for(const side of[-1,1])ellipsoid('bob-side',a.hairColor,head,side*.299,-.035,.00,.17,.54,.29);
        ellipsoid('bob-fringe',a.hairColor,head,0,.236,.213,.56,.135,.15);
      }else if(a.hairStyle==='bun'){
        if(a.hat==='none'){ellipsoid('high-bun',a.hairColor,head,0,.443,-.14,.33,.31,.31);torus('bun-band',palette.gold,head,0,.349,-.14,.217,.035);}
        ellipsoid('bun-fringe',a.hairColor,head,-.13,.253,.183,.35,.16,.18);
      }else if(a.hairStyle==='spikes'){
        if(a.hat==='none')for(const[x,y,z,rx,rz]of[[-.23,.36,0,-.12,.30],[-.09,.42,.06,.18,.10],[.07,.43,.02,.22,-.1],[.23,.35,-.02,-.1,-.4]]){
          cylinder('tousled-tuft',a.hairColor,head,x,y,z,.025,.23,.24,[rx,0,rz],5);
        }
        ellipsoid('tousled-fringe',a.hairColor,head,.07,.24,.21,.42,.15,.18,8);
      }
    }
    const sleeveLength=a.topStyle==='tee'?.21:.39;
    for(const [arm,side]of[[armL,-1],[armR,1]]){
      ellipsoid('sleeve-shoulder',a.topColor,arm,side*.018,-.045,0,.212,.23,.223);
      cylinder('sleeve',a.topColor,arm,side*.025,-sleeveLength/2,0,.19,.155,sleeveLength);
      ellipsoid('forearm',a.skin,arm,side*.025,-.343,.009,.125,.29,.128);
      if(a.topStyle!=='tee')cylinder('cuff',a.topStyle==='jacket'?palette.ink:a.topColor,arm,side*.025,-.385,.01,.164,.16,.068);
      ellipsoid('hand',a.skin,arm,side*.023,-.492,.013,.168,.20,.145);
      ellipsoid('thumb',a.skin,arm,-side*.046,-.464,.065,.069,.102,.08,8);
    }
    if(a.bottomStyle==='skirt')garment('a-line-skirt',a.bottomColor,body,0,.40,0,[[0,1],[.055,1],[.34,.70]],.365,.234);
    for(const [leg,shin]of[[legL,shinL],[legR,shinR]]){
      const covered=a.bottomStyle==='pants';
      cylinder('upper-leg',a.bottomStyle==='skirt'?a.skin:a.bottomColor,leg,0,-.16,0,.225,.18,.35);
      if(a.bottomStyle==='shorts')cylinder('shorts-hem',a.bottomColor,leg,0,-.235,0,.235,.23,.13);
      cylinder('lower-leg',covered?a.bottomColor:a.skin,shin,0,-.14,0,.175,.13,.30);
      ellipsoid('knee',covered?a.bottomColor:a.skin,shin,0,0,.01,.181,.16,.185);
      if(!covered)cylinder('sock',palette.cream,shin,0,-.222,.004,.137,.139,.08);
      if(a.shoeStyle==='boots'){
        cylinder('boot-shaft',a.shoeColor,shin,0,-.215,.01,.182,.19,.19);
        box('boot-pull',palette.gold,shin,0,-.138,-.069,.036,.057,.02);
      }
      ellipsoid('shoe-upper',a.shoeColor,shin,0,-.293,.057,.226,.165,.358);
      ellipsoid('shoe-sole',palette.sole,shin,0,-.352,.062,.232,.066,.366);
      box('heel',a.shoeStyle==='boots'?palette.ink:palette.sole,shin,0,-.351,-.027,.155,.035,.14);
      for(const z of[.052,.095])box('laces',palette.cream,shin,0,-.226,z,.115,.014,.016);
    }
    if(a.hat==='beanie'){
      garment('beanie-crown',a.topColor,head,0,0,-.018,[[.245,1],[.31,1],[.46,.76],[.50,.15]],.365,.327);
      garment('beanie-cuff',palette.cream,head,0,0,-.018,[[.232,1],[.295,1]],.372,.333);
      ellipsoid('beanie-pom',a.topColor,head,0,.511,-.02,.15,.15,.15,8);
      box('beanie-label',palette.gold,head,.155,.269,.308,.052,.037,.017);
    }else if(a.hat==='cap'){
      garment('cap-crown',a.topColor,head,0,0,-.02,[[.245,1],[.34,.94],[.414,.48],[.43,.05]],.369,.327);
      ellipsoid('cap-visor',a.topColor,head,0,.258,.297,.60,.065,.42);
      box('cap-mark',palette.gold,head,0,.339,.292,.064,.06,.025,[0,0,Math.PI/4]);
    }
    if(a.glasses!=='none'){
      for(const side of[-1,1]){
        if(a.glasses==='round')torus('round-glasses',palette.ink,head,side*.137,.006,.321,.182,.018,[Math.PI/2,0,0]);
        else{for(const y of[-.071,.079])box('glasses-horizontal',palette.ink,head,side*.139,y,.324,.19,.018,.02);for(const x of[-.096,.096])box('glasses-side',palette.ink,head,side*.139+x,.004,.324,.018,.15,.02);}
        box('glasses-arm',palette.ink,head,side*.256,.030,.173,.014,.017,.29);
      }
      box('glasses-bridge',palette.ink,head,0,.023,.329,.065,.019,.025);
    }
    if(a.headphones==='over-ear'){
      // An actual arch, not a face-facing sprite. Cups extend beyond both ears.
      for(let i=0;i<12;i++){const theta=(i+.5)/12*Math.PI;const m=box('headphone-band',palette.ink,head,Math.cos(theta)*.387,Math.sin(theta)*.438-.015,-.02,.114,.032,.095);m.rotation.z=theta;}
      for(const side of[-1,1]){ellipsoid('headphone-cup',palette.ink,head,side*.379,-.006,-.005,.12,.26,.22);ellipsoid('headphone-accent',palette.gold,head,side*.432,-.006,-.005,.018,.15,.13);}
    }
    if(a.bag==='backpack'){
      garment('backpack',a.bottomColor,body,0,.85,-.226,[[0,.8],[.04,1],[.35,1],[.42,.75]],.228,.12);
      box('backpack-pocket',a.topColor,body,0,.985,-.353,.32,.15,.047);
      box('backpack-zip',palette.gold,body,0,1.065,-.382,.26,.019,.02);
      for(const x of[-.195,.195]){box('backpack-strap',palette.ink,body,x,1.084,.157,.05,.42,.027);ellipsoid('strap-top',palette.ink,body,x,1.277,-.02,.055,.068,.29);}
    }else if(a.bag==='satchel'){
      box('crossbody-strap',palette.ink,body,0,1.05,.187,.041,.66,.032,[0,0,-.57]);
      garment('satchel',a.bottomColor,body,.293,.665,.058,[[0,.8],[.035,1],[.22,1],[.25,.88]],.145,.099);
      box('satchel-flap',a.topColor,body,.293,.84,.161,.258,.097,.02);
      box('satchel-clasp',palette.gold,body,.293,.798,.179,.045,.039,.015);
    }
    // Merge in local coordinates, then attach to the correct joint. This preserves
    // all volume and coloration without dozens of tiny draw calls per person.
    for(const [parent,pieces]of groups){if(!pieces.length)continue;const merged=Mesh.MergeMeshes(pieces,true,true,undefined,false,false);merged.name=parent.name+'-geometry';merged.parent=parent;merged.material=material;merged.isPickable=false;merged.useVertexColors=true;merged.hasVertexAlpha=false;merged.metadata={type:'avatar-mesh',joint:parent.name};meshes.push(merged);if(parent===head)headGeometry={mesh:merged,positions:merged.getVerticesData(VertexBuffer.PositionKind)};shadowGenerator?.addShadowCaster?.(merged);}
  }
  build(input);
  function update({position,velocity,heading,moving,running=false,seated=false,seatHeight=.61,airborne=false,waving=false,dt=1/60,time}={}){
    if(disposed)return;
    const step=Math.min(.1,Math.max(0,Number.isFinite(dt)?dt:0));clock=Number.isFinite(time)?time:clock+step;
    if(position)root.position.set(position.x||0,position.y||0,position.z||0);
    const speed=velocity?Math.hypot(velocity.x||0,velocity.z||0):0;
    const walking=!seated&&!airborne&&(moving??speed>.025);
    // Heading comes from world velocity, independently of camera orbit or pitch.
    if(speed>.025)lastHeading=Math.atan2(velocity.x,velocity.z);
    else if(Number.isFinite(heading))lastHeading=heading;
    root.rotation.y+=shortestAngle(root.rotation.y,lastHeading)*(1-Math.exp(-step*22));
    const target=walking?1:0;gait+=(target-gait)*(1-Math.exp(-step*13));
    phase+=step*(running?19:9.2)*(walking?1:.4);
    const swing=Math.sin(phase),stride=(running?.83:.50)*gait;
    legL.rotation.x=swing*stride;legR.rotation.x=-swing*stride;
    shinL.rotation.x=Math.max(0,-swing)*(running?.85:.45)*gait;shinR.rotation.x=Math.max(0,swing)*(running?.85:.45)*gait;
    armL.rotation.x=-swing*stride*.85-(running?.16:0)*gait;armR.rotation.x=swing*stride*.85-(running?.16:0)*gait;
    armL.rotation.z=-.09-Math.sin(clock*1.7)*.014*(1-gait);armR.rotation.z=.09+Math.sin(clock*1.7)*.014*(1-gait);
    body.position.y=Math.sin(clock*2)*.012*(1-gait)+Math.abs(Math.sin(phase))*(running?.065:.027)*gait;
    body.rotation.x=(running?.055:.015)*gait;body.rotation.z=swing*.018*gait;
    if(seated){body.position.y=seatHeight/root.scaling.y-.70;body.rotation.x=0;body.rotation.z=0;legL.rotation.x=legR.rotation.x=-Math.PI/2;shinL.rotation.x=shinR.rotation.x=Math.PI/2;armL.rotation.x=armR.rotation.x=-.35;}
    else if(airborne){legL.rotation.x=-.2;legR.rotation.x=.18;shinL.rotation.x=shinR.rotation.x=.3;armL.rotation.z=-.4;armR.rotation.z=.4;}
    if(waving){armR.rotation.z=2.45+Math.sin(clock*13)*.25;armR.rotation.x=-.25;}
    head.rotation.x=-.018*gait+Math.sin(clock*1.3)*.012*(1-gait);head.rotation.z=Math.sin(clock*.8)*.015*(1-gait);
  }
  update({dt:0});
  // The merged head includes hair and hats, and inherits the live pose and scale.
  function getHeadGeometry(){if(disposed)return null;headGeometry.mesh.computeWorldMatrix(true);return headGeometry;}
  return{root,getHeadGeometry,get meshes(){return meshes;},get appearance(){return normalizeAppearance(appearance);},get heading(){return lastHeading;},update,
    setAppearance(value){if(appearanceKey(value)!==appearanceHash){build(value);update({dt:0});}},
    dispose(){if(disposed)return;disposed=true;for(const m of meshes)shadowGenerator?.removeShadowCaster?.(m);root.dispose(false,false);meshes=[];parts=[];},
  };
}
