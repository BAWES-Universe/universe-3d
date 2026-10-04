import test from 'node:test';
import assert from 'node:assert/strict';
import { attachRoomFile, listRoomFiles, deleteRoomFile, restoreRoomFile, MAX_FILE_BYTES, FILE_ACCEPT } from '../src/files.js';

test('document client sends raw file with cookie credentials, Unicode filename and abort signal', async t => {
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; });
  const file = new File(['hello'], 'Résumé.txt', {type:'text/plain'}), abort = new AbortController();
  let call;
  const metadata = {id:'file-1',roomId:'commons',name:file.name,size:file.size,url:'/api/rooms/commons/files/file-1'};
  globalThis.fetch = async (path, options) => { call = {path,options}; return {ok:true,json:async () => ({file:metadata})}; };
  assert.deepEqual(await attachRoomFile({roomId:'commons',file,signal:abort.signal}), metadata);
  assert.equal(call.path, '/api/rooms/commons/files'); assert.equal(call.options.method,'POST');
  assert.equal(call.options.credentials,'same-origin'); assert.equal(call.options.body,file); assert.equal(call.options.signal,abort.signal);
  assert.equal(call.options.headers['X-File-Name'],'R%C3%A9sum%C3%A9.txt');
  assert.equal(call.options.headers['X-File-Type'],'text/plain');
  assert.equal(call.options.headers['Content-Type'],'application/octet-stream');
  assert.equal(call.options.headers['X-Universe-Client-Capabilities'],'image-physical-size-v1');
  assert.match(FILE_ACCEPT,/\.pdf/);
});

test('document client rejects empty/oversize files before upload and preserves API errors', async t => {
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; }); let calls = 0;
  globalThis.fetch = async () => { calls++; return {ok:false,status:403,json:async () => ({code:'ROOM_FORBIDDEN',message:'You do not have permission for this room'})}; };
  await assert.rejects(attachRoomFile({roomId:'commons',file:new File([],'empty.txt')}),/non-empty/);
  await assert.rejects(attachRoomFile({roomId:'commons',file:{name:'big.txt',size:MAX_FILE_BYTES+1}}),/5 MiB/);
  await assert.rejects(attachRoomFile({roomId:'../other',file:new File(['ok'],'notes.txt')}),/Choose a room/);
  assert.equal(calls,0);
  await assert.rejects(attachRoomFile({roomId:'commons',file:new File(['ok'],'notes.txt')}),error => error.status === 403 && error.code === 'ROOM_FORBIDDEN');
  assert.equal(calls,1);
});

test('document listing and recoverable removal helpers use the room-scoped routes', async t => {
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; }); const calls = [];
  globalThis.fetch = async (path, options) => { calls.push({path,options}); return {ok:true,json:async () => ({files:[]})}; };
  await listRoomFiles('commons',{includeDeleted:true}); await deleteRoomFile('commons','file-1'); await restoreRoomFile('commons','file-1');
  assert.deepEqual(calls.map(call => call.path), ['/api/rooms/commons/files?includeDeleted=1','/api/rooms/commons/files/file-1','/api/rooms/commons/files/file-1/restore']);
  assert.equal(calls[1].options.method,'DELETE'); assert.equal(calls[2].options.method,'POST');
  assert.ok(calls.every(call => call.options.credentials === 'same-origin'));
  assert.ok(calls.every(call => call.options.headers['X-Universe-Client-Capabilities'] === 'image-physical-size-v1'));
});

test('format rejection on a direct document request notifies the reload boundary before rejecting', async t => {
  const oldFetch=globalThis.fetch,oldDispatch=globalThis.dispatchEvent;
  t.after(()=>{globalThis.fetch=oldFetch;if(oldDispatch===undefined)delete globalThis.dispatchEvent;else globalThis.dispatchEvent=oldDispatch;});
  const events=[];globalThis.dispatchEvent=event=>{events.push({type:event.type,detail:event.detail});return true;};
  globalThis.fetch=async()=>({ok:false,status:426,json:async()=>({error:'CLIENT_RELOAD_REQUIRED',code:'CLIENT_RELOAD_REQUIRED',message:'Export and reload'})});
  await assert.rejects(listRoomFiles('commons'),error=>error.status===426&&error.code==='CLIENT_RELOAD_REQUIRED');
  assert.deepEqual(events,[{type:'universe-client-reload-required',detail:{error:'CLIENT_RELOAD_REQUIRED',code:'CLIENT_RELOAD_REQUIRED',message:'Export and reload'}}]);
});
