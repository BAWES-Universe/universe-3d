import {IMAGE_ASSET_LIMITS} from './image-asset-schema.js';

function encodedBytes(bytes){
 if(!(bytes instanceof Uint8Array)||bytes.byteLength>IMAGE_ASSET_LIMITS.maxBytes)throw new Error('This image exceeds the supported recovery size. Keep the original file before reloading.');
 let binary='';for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
 return {encoding:'base64',data:btoa(binary)};
}
/** Read upload bytes only after the user's explicit Export action. No auto retry. */
export async function serializeImageRecovery(snapshot){
 if(snapshot?.format!=='universe-image-recovery'||snapshot.version!==1)throw new Error('No image draft is available to export.');
 const result={...snapshot,notice:'Recovery copy only. A pending operation may already have committed. Check the same operation receipt after reloading before publishing again; this file does not automatically restore or retry it.'};
 if(snapshot.uploadDraft){
  const {file,...draft}=snapshot.uploadDraft;
  if(!file||typeof file.arrayBuffer!=='function'||file.size>IMAGE_ASSET_LIMITS.maxBytes)throw new Error('Keep the original image file before reloading; its recovery copy is unavailable.');
  result.uploadDraft={...draft,file:{name:file.name,type:file.type,lastModified:file.lastModified,bytes:encodedBytes(new Uint8Array(await file.arrayBuffer()))}};
 }
 if(snapshot.pendingUpload)result.pendingUpload={...snapshot.pendingUpload,bytes:encodedBytes(snapshot.pendingUpload.bytes)};
 return JSON.stringify(result,null,2);
}
