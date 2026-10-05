/** Camera-aligned top-down plan. X/Z are projected onto the camera's screen
 * right/down basis; use the exact inverse for clicks and keyboard movement. */
export function createBotPlanGeometry({width=32,depth=26,angle=Math.PI/4,viewWidth=360,viewHeight=220,padding=22}={}) {
 const sin=Math.sin(angle),cos=Math.cos(angle);
 const projectedWidth=Math.abs(sin)*width+Math.abs(cos)*depth;
 const projectedDepth=Math.abs(cos)*width+Math.abs(sin)*depth;
 const scale=Math.min((viewWidth-2*padding)/projectedWidth,(viewHeight-2*padding)/projectedDepth);
 const project=({x=0,z=0})=>{x=Number.isFinite(x)?x:0;z=Number.isFinite(z)?z:0;return{x:viewWidth/2+(-sin*x+cos*z)*scale,y:viewHeight/2+(cos*x+sin*z)*scale};};
 const unproject=({x,y})=>{const right=(x-viewWidth/2)/scale,down=(y-viewHeight/2)/scale;return{x:-sin*right+cos*down,z:cos*right+sin*down};};
 const delta=(right,down)=>({x:-sin*right+cos*down,z:cos*right+sin*down});
 function rectangle({x=0,z=0,width=1,depth=1,rotation=0}) {const a=rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([dx,dz])=>project({x:x+dx*width/2*c-dz*depth/2*s,z:z+dx*width/2*s+dz*depth/2*c}));}
 return {scale,project,unproject,delta,rectangle};
}
