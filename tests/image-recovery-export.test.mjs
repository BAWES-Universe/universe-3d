import test from 'node:test';
import assert from 'node:assert/strict';
import {serializeImageRecovery} from '../src/image-recovery-export.js';
import {IMAGE_ASSET_LIMITS} from '../src/image-asset-schema.js';

test('image recovery preserves original bytes, settings and uncertain operation identity',async()=>{
 const bytes=new Uint8Array([1,2,3,240]),file=new File([bytes],'original.png',{type:'image/png',lastModified:100});
 const snapshot={format:'universe-image-recovery',version:1,accountId:'owner',roomId:'room',uploadDraft:{file,fields:{name:'Draft',widthMetres:2}},pendingUpload:{operationId:'same-operation',state:'uncertain',draft:{widthMetres:2},bytes},setupDrafts:[{operationId:'same-setup',fields:{widthMetres:4}}]};
 const result=JSON.parse(await serializeImageRecovery(snapshot));
 assert.deepEqual([...Buffer.from(result.uploadDraft.file.bytes.data,'base64')],[...bytes]);
 assert.deepEqual([...Buffer.from(result.pendingUpload.bytes.data,'base64')],[...bytes]);
 assert.equal(result.pendingUpload.operationId,'same-operation');assert.equal(result.pendingUpload.state,'uncertain');
 assert.deepEqual(result.setupDrafts,snapshot.setupDrafts);assert.match(result.notice,/may already have committed/);
 assert.equal(snapshot.uploadDraft.file,file);assert.equal(snapshot.pendingUpload.bytes,bytes);
});
test('recovery refuses unsupported upload size before reading bytes',async()=>{
 let read=false;const snapshot={format:'universe-image-recovery',version:1,uploadDraft:{file:{size:IMAGE_ASSET_LIMITS.maxBytes+1,arrayBuffer:async()=>{read=true;return new ArrayBuffer(0);}}}};
 await assert.rejects(serializeImageRecovery(snapshot),/Keep the original/);assert.equal(read,false);
});
