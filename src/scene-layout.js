// Low terrain detail is deliberately walk-through. Tall, solid props are authored
// in worlds.js so the rendered furniture and server collision always agree.
export function buildEnvironment(world,root,{box,cylinder,sphere,ground,material,line}){
 const {width:w,depth:d}=world.bounds,theme=world.theme||'garden';
 const b=(name,x,y,z,bw,bh,bd,color,kind='stone')=>box(name,x,y,z,bw,bh,bd,color,root,{surface:kind,pickable:false});
 b('bedrock',0,-.63,0,w+.5,1.05,d+.5,'#545161','slate');
 b('sandstone-course',0,-.14,0,w+.27,.18,d+.27,'#bfc0ad');
 b('edge-cap',0,-.075,0,w+.16,.09,d+.16,'#d9d9c5');
 const floor=ground('walkable-ground',0,0,0,w,d,theme==='garden'?'grass':theme==='studio'?'wood':'slate',theme==='garden'?'#d0dabc':theme==='studio'?'#ccc0b9':'#ae9ec2',root,true);
 if(w<26||d<22){ground('compact-court',0,.023,0,Math.min(w-1,6),Math.min(d-1,6),'stone','#d5d2ba',root);return floor;}
 if(theme==='garden'){
  const pad=(name,x,z,pw,pd,kind='stone',tint='#ddd8bd')=>{b(name+'-border',x,.008,z,pw+.22,.028,pd+.22,'#8a9b87');ground(name,x,.03,z,pw,pd,kind,tint,root);};
  const north=3-d/2,south=d/2;
  pad('commons-promenade',0,(north+4.65)/2,3.35,4.65-north);
  pad('commons-entry',0,(9.35+south)/2,3.35,south-9.35);
  pad('portal-walk',0,-6,w-5.5,3.1);
  pad('table-deck',-6,-1.8,7.7,6.8,'wood','#d1b8a0');
  pad('quiet-terrace',6,-3,8,6.4,'stone','#c0c8b0');
  // Arrival is a slight widening of the same path paving, never a raised plate.
  pad('arrival-court',0,7,4.8,4.7,'stone','#ddd8bd');
  // Short deck seams and recessed metal corner fittings give furniture a place.
  for(const x of [-9.5,-2.5])for(const z of [-4.8,1.2])b('deck-stud',x,.06,z,.085,.035,.085,'#7a6b60','slate');
  for(let i=0;i<16;i++){
   const x=-w/2+.55+i*(w-1.1)/15;
   for(const z of [-d/2+.28,d/2-.28])b('border-stone',x,.045,z,(w-1.8)/16,.09,.35,i%3?'#b7bca8':'#c8c8b1');
  }
  // Planting strips follow the perimeter without creating hidden collision.
  for(const side of [-1,1])for(let i=0;i<12;i++){
   const z=-d/2+1+i*(d-2)/11,x=side*(w/2-.5);
   ground('mulch-bed',x,.034,z,.72,1.28,'soil','#beb29f',root);
   for(let k=0;k<3;k++){
    const xx=x+(k-1)*.18,zz=z+((i+k)%3-1)*.23;
    const flower=sphere('border-foliage',xx,.12,zz,.16,['#91b174','#83a26b','#9cb375'][i%3],root,.7,{surface:'leaves',pickable:false});
    if((i+k)%3===0)sphere('border-blossom',xx,.24,zz,.065,i%2?'#e6bf73':'#c6addb',root,.7,{pickable:false});
   }
  }
  // Low perennial beds and stepping stones make the quiet edges readable.
  for(const [cx,cz,sx,sz] of [[-11.8,2.4,1.5,2.7],[11.8,6,1.5,2.3],[-6.3,8.8,2.2,1.4],[7.3,9.9,2.1,1.25]]){
   ground('perennial-bed',cx,.036,cz,sx,sz,'soil','#b4a591',root);
   for(let k=0;k<18;k++){
    const a=k*2.399,r=Math.sqrt((k+.5)/18),x=cx+Math.cos(a)*sx*.42*r,z=cz+Math.sin(a)*sz*.42*r;
    sphere('sage-leaves',x,.14,z,.16,k%2?'#9cad83':'#7d9875',root,.65,{surface:'leaves',pickable:false});
    if(k%2===0){cylinder('flower-stem',x,.22,z,.016,.35,'#80946b',root,.012,{pickable:false});sphere('flower-head',x,.4,z,.07,k%3?'#d3b8e0':'#e9d199',root,.5,{pickable:false});}
   }
  }
  for(let i=0;i<5;i++){const x=-9.8+i*.23,z=2.2+i*.55;b('garden-step',x,.044,z,.62,.055,.38,'#c5c7b2');}
  // Fine inlaid navigation stones, with no fake screen or placeholder content.
  for(const x of [-1,1])for(let z=2;z<10;z+=1.2)b('path-inlay',x*1.32,.056,z,.10,.012,.22,'#b095b9','slate');
 }else{
  b('studio-foundation',0,-.03,0,w-.6,.02,d-.6,theme==='studio'?'#ddcbb7':'#b2a1bf',theme==='studio'?'wood':'slate');
  ground('central-work-area',0,.014,-1,16,14,theme==='studio'?'wood':'stone',theme==='studio'?'#c5b49e':'#b6afba',root);
  for(const side of [-1,1]){
   b('side-brick-course',side*(w/2-.25),.04,0,.4,.09,d-.5,'#b6aba8');
   b('back-brick-course',0,.04,side*(d/2-.25),w-.5,.09,.4,'#b6aba8');
  }
  if(theme==='studio'){
   for(let x=-11;x<=11;x+=2.2)ground('workshop-floor-inlay',x,.04,6.6,.48,.11,'slate','#8d7c89',root);
  }else{
   ground('stage-surround',0,.035,-7,13.3,6.4,'wood','#c5aabc',root);
   ground('aisle',0,.025,4,1.5,12,'stone','#d7cfc3',root);
  }
 }
 return floor;
}
