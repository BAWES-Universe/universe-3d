import {DynamicTexture} from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial.js';
import {Texture} from '@babylonjs/core/Materials/Textures/texture.js';
import {Color3} from '@babylonjs/core/Maths/math.color.js';
// Original repeatable material art. No third-party tilesets are copied or cropped.
export function createEnvironmentMaterials(scene){
 const textures=new Map(),materials=new Map();
 function texture(kind){
  if(textures.has(kind))return textures.get(kind);
  const tex=new DynamicTexture('original-'+kind,{width:128,height:128},scene,true,Texture.TRILINEAR_SAMPLINGMODE),c=tex.getContext();
  let seed=kind.split('').reduce((a,s)=>a+s.charCodeAt(0),73);const rand=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
  const palettes={grass:['#7e9a77','#87a17d','#76916f','#94a784'],stone:['#d3cbb7','#ddd5c1','#c6c1ae','#ccc6b4'],wood:['#bda078','#c9ad85','#aa8963','#d3b88f'],bark:['#756651','#85745c','#605645','#998269'],slate:['#686477','#767084','#555565','#81778d'],fabric:['#bab3bf','#ccc5cf','#a79cba','#e0d5df'],leaves:['#b2c6a1','#c1cfae','#9eb88f','#d3d8b3'],soil:['#716455','#817561','#5f594d','#958671'],water:['#407f87','#519697','#36727f','#77b5ae']};
  const p=palettes[kind]||palettes.stone;c.fillStyle=p[0];c.fillRect(0,0,128,128);
  for(let i=0;i<1800;i++){c.fillStyle=p[Math.floor(rand()*p.length)];c.globalAlpha=(kind==='grass'||kind==='stone'||kind==='leaves'?.07:.14)+rand()*.12;const x=Math.floor(rand()*128),y=Math.floor(rand()*128);c.fillRect(x,y,kind==='wood'?3+rand()*11:1+rand()*3,kind==='bark'?8+rand()*15:1+rand()*2);}
  c.globalAlpha=1;
  if(kind==='stone'||kind==='slate')for(let y=0;y<128;y+=32){c.fillStyle=kind==='stone'?'#afa894':'#555160';c.fillRect(0,y,128,1);c.fillStyle=kind==='stone'?'#e6deca':'#94869f';c.fillRect(0,y+2,128,1);for(let x=((y/32)%2)*32;x<128;x+=64){c.fillStyle=kind==='stone'?'#b6af9d':'#615b6b';c.fillRect(x,y,1,32);}}
  if(kind==='wood'){for(let y=0;y<128;y+=32){c.fillStyle='#826948';c.fillRect(0,y,128,2);c.fillStyle='#dcc397';c.fillRect(0,y+2,128,1);for(let k=0;k<7;k++){c.globalAlpha=.18;c.strokeStyle='#694f3c';c.beginPath();c.moveTo(0,y+5+k*3);c.bezierCurveTo(35,y+k*3,66,y+12+k*3,128,y+5+k*3);c.stroke();}c.globalAlpha=1;c.fillStyle='#6d5c4b';c.fillRect(5,y+5,2,2);c.fillRect(120,y+26,2,2);}}
  if(kind==='grass'){for(let i=0;i<190;i++){const x=rand()*128,y=rand()*128;c.fillStyle=p[i%4];c.fillRect(x,y,1,3);c.fillRect(x+1,y-1,1,3);}}
  if(kind==='fabric'){c.globalAlpha=.25;for(let i=0;i<128;i+=4){c.fillStyle=i%8?'#615976':'#fbf0eb';c.fillRect(i,0,1,128);c.fillRect(0,i,128,1);}c.globalAlpha=1;}
  if(kind==='leaves'){for(let i=0;i<230;i++){c.fillStyle=p[i%4];const x=rand()*128,y=rand()*128;c.fillRect(x,y,4,2);c.fillRect(x+1,y-1,2,4);}}
  if(kind==='water'){
   // Opaque, flat teal enamel: a readable painted surface, never simulated depth.
   // Periodic wave coordinates tile exactly in both axes at the shared 2m scale.
   c.fillStyle='#529d9b';c.fillRect(0,0,128,128);
   for(let row=-1;row<=4;row++)for(let pass=0;pass<2;pass++){
    c.strokeStyle=pass?'#cce5cf':'#387e89';c.globalAlpha=pass?.34:.15;c.lineWidth=pass?1.6:4;c.beginPath();
    for(let x=0;x<=128;x++){const y=row*32+Math.sin(x*Math.PI/64+row*Math.PI)*4+pass*4;if(x===0)c.moveTo(x,y);else c.lineTo(x,y);}c.stroke();
   }
   c.globalAlpha=1;
  }
  tex.update(false);tex.wrapU=Texture.WRAP_ADDRESSMODE;tex.wrapV=Texture.WRAP_ADDRESSMODE;tex.anisotropicFilteringLevel=4;textures.set(kind,tex);return tex;
 }
 function material(kind='stone',tint='#ffffff',alpha=1){const key=kind+tint+alpha;if(materials.has(key))return materials.get(key);const m=new StandardMaterial(key,scene);m.diffuseTexture=texture(kind);m.diffuseColor=Color3.FromHexString(tint);m.specularColor=kind==='water'?new Color3(.4,.48,.46):new Color3(.04,.04,.04);if(kind==='water'){m.specularPower=80;m.emissiveColor=new Color3(.015,.045,.05);}m.alpha=alpha;materials.set(key,m);return m;}
 return {material,textures,materials,tick(time,{motion=true}={}){const water=textures.get('water');if(water&&motion){water.uOffset=Math.sin(time*.21)*.013;water.vOffset=(time*.007)%1;}}};
}
