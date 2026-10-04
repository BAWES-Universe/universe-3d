import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createImageClientProtocol,IMAGE_PROTOCOL_FLOOR_KEY,acceptsImageProtocol,checkImageReaderCompatibility} from '../server/image-client-protocol.mjs';
const capability='image-physical-size-v1';
function fixture(row){let writes=0;return{store:{get:(_sql,key)=>key===IMAGE_PROTOCOL_FLOOR_KEY?row:null,run(){writes++;}},writes:()=>writes};}
test('a missing persisted floor differs from an invalid empty or future floor',()=>{
 const absent=fixture(undefined),policy=createImageClientProtocol({store:absent.store});assert.equal(policy.isRequired(),false);assert.equal(absent.writes(),0);
 for(const value of ['',null,'image-physical-size-v2','unrecognized']){const f=fixture({value});assert.throws(()=>createImageClientProtocol({store:f.store}),/newer image client protocol/);assert.equal(f.writes(),0,'invalid metadata is not rewritten');}
 const existing=fixture({value:capability}),compatible=createImageClientProtocol({store:existing.store});assert.deepEqual(compatible.status().storageCompatibility,{version:1,requiredReaderCapabilities:[capability]});assert.equal(compatible.isEnabled(),false);
});
test('package reader descriptor explicitly declares the capability retained by storage',async()=>{
 const descriptor=JSON.parse(await readFile(new URL('../server/image-protocol-capabilities.json',import.meta.url),'utf8'));
 assert.deepEqual(descriptor,{version:1,readerCapabilities:[capability]});
});
test('binary and admission exceptions are exact; metadata and writes remain fenced',()=>{
 const f=fixture({value:capability}),policy=createImageClientProtocol({store:f.store});
 const request=(url,method='GET')=>({url,method,headers:{}});
 for(const path of ['/api/rooms/r/files/f','/api/rooms/r/assets/a/versions/v/image'])for(const method of ['GET','HEAD'])assert.doesNotThrow(()=>policy.assertRequest(request(path,method)));
 for(const [path,method] of [['/api/site-invites','GET'],['/api/site-invites','POST'],['/api/site-invites/invite_1/revoke','POST'],['/api/site-admission/check','POST'],['/api/site-admission/redeem','POST']])assert.doesNotThrow(()=>policy.assertRequest(request(path,method)));
 for(const [path,method] of [['/api/rooms/r/files','GET'],['/api/rooms/r/files/f','DELETE'],['/api/rooms/r/assets/a/versions/v/image','POST'],['/api/site-invites/invite_1/unknown','POST'],['/api/rooms/r','GET']])assert.throws(()=>policy.assertRequest(request(path,method)),e=>e.status===426);
 assert.equal(acceptsImageProtocol(request('/api/rooms/r?capabilities='+capability)),false);assert.equal(acceptsImageProtocol(request('/api/events?capabilities='+capability)),true);
});


test('release comparison refuses missing, unknown and insufficient target descriptors',()=>{
 const requirement={version:1,requiredReaderCapabilities:[capability]};
 assert.deepEqual(checkImageReaderCompatibility(requirement,undefined),{compatible:false,code:'IMAGE_READER_DESCRIPTOR_MISSING'});
 for(const target of [{},{version:2,readerCapabilities:[capability]},{version:1,readerCapabilities:['unknown-reader']},{version:1,readerCapabilities:[capability],unknown:true}])assert.deepEqual(checkImageReaderCompatibility(requirement,target),{compatible:false,code:'IMAGE_READER_DESCRIPTOR_INVALID'});
 assert.deepEqual(checkImageReaderCompatibility(requirement,{version:1,readerCapabilities:[]}),{compatible:false,code:'IMAGE_READER_CAPABILITY_MISSING'});
 assert.deepEqual(checkImageReaderCompatibility(requirement,{version:1,readerCapabilities:[capability]}),{compatible:true,code:'IMAGE_READER_COMPATIBLE'});
 assert.equal(checkImageReaderCompatibility({version:2,requiredReaderCapabilities:[]},{version:1,readerCapabilities:[capability]}).compatible,false);
 assert.equal(checkImageReaderCompatibility({version:1,requiredReaderCapabilities:[]},undefined).compatible,false,'absence never means assumed compatibility');
});
