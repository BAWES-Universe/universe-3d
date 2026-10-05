import test from 'node:test';
import assert from 'node:assert/strict';
import {IMAGE_PHYSICAL_SIZE_CAPABILITY,COMPOSITION_FURNITURE_CAPABILITY,clientProtocolHeaders,clientEventsUrl,normalizeClientProtocol,supportsClientProtocol,isClientReloadRequired,createClientProtocolGuard} from '../src/client-protocol.js';

test('every request and stream explicitly declares this tab format',()=>{
 assert.deepEqual(clientProtocolHeaders({'Content-Type':'application/json'}),{'Content-Type':'application/json','X-Universe-Client-Capabilities':IMAGE_PHYSICAL_SIZE_CAPABILITY+','+COMPOSITION_FURNITURE_CAPABILITY});
 assert.equal(clientEventsUrl(),'/api/events?capabilities=image-physical-size-v1%2Ccomposition-furniture-v1');
 assert.equal(clientEventsUrl('/api/events?fixture=1'),'/api/events?fixture=1&capabilities=image-physical-size-v1%2Ccomposition-furniture-v1');
});
test('unknown server format cannot be accepted through permissive normalization',()=>{
 assert.deepEqual(normalizeClientProtocol(null),{enabled:false,required:false,capability:IMAGE_PHYSICAL_SIZE_CAPABILITY});
 assert.equal(supportsClientProtocol(normalizeClientProtocol({imagePhysicalSize:{enabled:true,required:true,capability:'future-format'}})),false);
 assert.equal(supportsClientProtocol(normalizeClientProtocol({imagePhysicalSize:{enabled:false,required:true,capability:IMAGE_PHYSICAL_SIZE_CAPABILITY}})),true);
});
test('retirement is permanent and rejects already pending success callbacks',async()=>{
 const notices=[],guard=createClientProtocolGuard(error=>notices.push(error.message));
 const early=guard.capture();guard.assertCurrent(early);
 assert.equal(guard.retire({reason:'Export and reload'}),true);
 assert.equal(guard.retire({reason:'A duplicate event'}),false);
 assert.deepEqual(notices,['Export and reload']);assert.equal(guard.isRetired(),true);
 assert.throws(()=>guard.assertCurrent(early),error=>error.status===426&&isClientReloadRequired(error.data));
 assert.throws(()=>guard.assertCurrent(),error=>error.status===426);
});
test('HTTP, legacy-compatible SSE and structured error forms identify the same boundary',()=>{
 for(const value of [{error:'CLIENT_RELOAD_REQUIRED'},{code:'CLIENT_RELOAD_REQUIRED'},{error:{code:'CLIENT_RELOAD_REQUIRED'}}])assert.equal(isClientReloadRequired(value),true);
 assert.equal(isClientReloadRequired({error:'ROOM_FORBIDDEN'}),false);
});
