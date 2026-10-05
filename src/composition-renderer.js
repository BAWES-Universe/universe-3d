import {Mesh} from '@babylonjs/core/Meshes/mesh.js';
import {VertexData} from '@babylonjs/core/Meshes/mesh.vertexData.js';
import {TransformNode} from '@babylonjs/core/Meshes/transformNode.js';
import {Quaternion} from '@babylonjs/core/Maths/math.vector.js';
import {Color3} from '@babylonjs/core/Maths/math.color.js';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial.js';
import {validate} from '../modules/asset-workshop/model.js';
import {geometry} from '../modules/asset-workshop/geometry.js';
import {resolveCompositionPlacement} from './composition-geometry.js';

/** Native scene meshes only. A view owns every mesh/material it allocates. Texture
 * references stay inert; neither this adapter nor its materials request URLs. */
export function createCompositionObjectView({scene,definition,instance,preview=false}){
 if(!scene)throw new Error('A Babylon scene is required');
 const node=new TransformNode(`composition-${instance.id}`,scene);
 let meshes=[],materials=[],disposed=false,definitionSignature=null,current=null;
 function clear(){for(const mesh of meshes)mesh.dispose(false,false);meshes=[];for(const material of materials)material.dispose(false,false);materials=[];}
 function dispose(){if(disposed)return;disposed=true;clear();if(!node.isDisposed())node.dispose(false,false);}
 function update({definition:nextDefinition,instance:nextInstance,preview:nextPreview=preview}){
  if(disposed)throw new Error('This composition view is disposed');
  let doc,placement;try{doc=validate(nextDefinition);placement=resolveCompositionPlacement(doc,nextInstance);}catch(error){dispose();throw error;}
  const signature=JSON.stringify(doc),metadata={id:placement.instanceId,type:nextPreview?'composition-ghost':'object',kind:'composition',assetRef:{...placement.assetRef},compositionObject:true,dynamic:true};
  if(signature!==definitionSignature){
   clear();definitionSignature=signature;
   try{
    const byId=new Map();
    for(const source of doc.materials){
     const material=new StandardMaterial(`composition-${placement.instanceId}-${source.id}`,scene);
     material.diffuseColor=Color3.FromHexString(source.color);material.specularColor=new Color3(.08,.08,.08);material.specularPower=Math.max(1,128*(1-source.roughness));
     material.backFaceCulling=true;material.metadata={compositionMaterial:true,materialId:source.id,textureRef:source.textureRef?{...source.textureRef}:null};
     materials.push(material);byId.set(source.id,material);
    }
    for(const component of doc.components){
     const mesh=new Mesh(`composition-${placement.instanceId}-${component.id}`,scene),data=new VertexData();
     meshes.push(mesh);mesh.parent=node;Object.assign(data,geometry(component.shape));data.applyToMesh(mesh);
     mesh.position.set(...component.position);mesh.rotationQuaternion=new Quaternion(...component.rotation);mesh.scaling.set(...component.size);mesh.material=byId.get(component.materialId);
     mesh.metadata={...metadata,componentId:component.id};mesh.receiveShadows=!nextPreview;
    }
   }catch(error){dispose();throw error;}
  }
  node.metadata=metadata;node.position.set(...placement.transform.position);node.rotationQuaternion=new Quaternion(...placement.transform.quaternion);
  for(let index=0;index<meshes.length;index++){
   const mesh=meshes[index];mesh.metadata={...metadata,componentId:doc.components[index].id};mesh.isPickable=!nextPreview;mesh.receiveShadows=!nextPreview;
  }
  node.computeWorldMatrix(true);for(const mesh of meshes)mesh.computeWorldMatrix(true);
  current=placement;preview=nextPreview;return current;
 }
 node.onDisposeObservable.addOnce(dispose);
 try{update({definition,instance,preview});}catch(error){dispose();throw error;}
 return {node,get meshes(){return meshes;},get materials(){return materials;},update,dispose,getState:()=>({status:disposed?'disposed':'ready',placement:current})};
}
export const createBabylonCompositionObjectView=createCompositionObjectView;
