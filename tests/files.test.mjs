import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGameServer } from '../server/app.mjs';
import { MAX_FILE_BYTES, MAX_ROOM_FILES } from '../server/files.mjs';
import { seedWorlds } from '../src/worlds.js';

async function fixture(database = ':memory:') {
  const app = createGameServer({ database, seeds: seedWorlds });
  const { port } = await app.listen(0), base = `http://127.0.0.1:${port}`;
  const client = (cookie = '') => ({ cookie, async call(path, method = 'GET', body, headers = {}) {
    const response = await fetch(base + path, { method, headers: { Cookie: this.cookie, ...(body === undefined ? {} : { 'Content-Type':'application/json' }), ...headers }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    if (response.headers.get('set-cookie')) this.cookie = response.headers.get('set-cookie').split(';')[0];
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : undefined };
  }, upload(name = 'notes.txt', bytes = Buffer.from('Hello document'), type = 'text/plain', room = 'commons', headers = {}) {
    return this.call(`/api/rooms/${room}/files`, 'POST', bytes, { 'Content-Type':'application/octet-stream', 'X-File-Name':encodeURIComponent(name), 'X-File-Type':type, ...headers });
  } });
  const guest = async name => { const c = client(); const r = await c.call('/api/session', 'POST', { name, woka:0 }); assert.equal(r.status, 201); c.user = r.data.user; return c; };
  return { app, port, base, client, guest };
}

async function joinRoom(c, room = 'commons') { assert.equal((await c.call(`/api/rooms/${room}/join`, 'POST', {})).status, 200); }

test('room uploads require editor writes and hierarchy-authorized guest reads', async t => {
  const f = await fixture(); t.after(() => f.app.close());
  const owner = await f.guest('Owner'), member = await f.guest('Member'), stranger = await f.guest('Stranger');
  await joinRoom(member);
  assert.equal((await f.client().upload()).status, 401);
  assert.equal((await member.upload()).status, 403);
  const uploaded = await owner.upload(); assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
  const file = uploaded.data.file;
  assert.equal(file.name, 'notes.txt'); assert.equal(file.size, 14); assert.equal(file.createdBy, owner.user.id);
  assert.equal((await stranger.call(file.url)).status, 200);
  assert.equal(f.app.store.get('SELECT COUNT(*) AS n FROM world_members WHERE user_id=?',stranger.user.id).n,0);
  assert.equal((await stranger.call('/api/rooms/commons/files')).status, 200);
  const room=(await owner.call('/api/rooms/commons')).data.room;
  await owner.call(`/api/worlds/${room.worldId}`, 'PATCH', {public:false});
  assert.equal((await stranger.call(file.url)).status,404);
  assert.equal((await stranger.call('/api/rooms/commons/files')).status,404);
  await owner.call(`/api/worlds/${room.worldId}`, 'PATCH', {public:true});
  assert.equal((await member.call(file.url)).bytes.toString(), 'Hello document');
  assert.equal((await member.call('/api/rooms/commons/files')).data.files[0].id, file.id);
  await owner.call(`/api/rooms/commons/members/${member.user.id}`, 'PUT', { role:'editor' });
  assert.equal((await member.upload('editor.pdf', Buffer.from('%PDF-1.7\nexample'), 'application/pdf')).status, 201);
  await owner.call(`/api/rooms/commons/members/${member.user.id}`, 'PUT', { role:'member' });
  assert.equal((await member.upload()).status, 403);
  assert.equal((await member.call(file.url, 'DELETE')).status, 403);
  await owner.call('/api/rooms/commons/moderate', 'POST', { userId:member.user.id, action:'ban' });
  assert.equal((await member.call(file.url)).status, 404);
  assert.equal((await member.call('/api/rooms/commons/files')).status, 404);
});

test('file IDs cannot be used through another room even by an owner of both', async t => {
  const f = await fixture(); t.after(() => f.app.close()); const owner = await f.guest('Owner');
  const file = (await owner.upload()).data.file, other = `/api/rooms/studio/files/${file.id}`;
  assert.equal((await owner.call(other)).status, 404);
  assert.equal((await owner.call(other, 'DELETE')).status, 404);
  assert.equal((await owner.call(other + '/restore', 'POST')).status, 404);
  assert.equal((await owner.call('/api/rooms/studio/files')).data.files.length, 0);
  assert.equal((await owner.call(file.url)).status, 200);
});

test('downloads force safe attachment headers, retain Unicode filenames and never execute HTML', async t => {
  const f = await fixture(); t.after(() => f.app.close()); const owner = await f.guest('Owner');
  assert.equal((await owner.upload('evil.html', Buffer.from('<script>alert(1)</script>'), 'text/html')).status, 415);
  assert.equal((await owner.upload('evil.svg', Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml')).status, 415);
  assert.equal((await owner.upload('fake.png', Buffer.from('<html>evil</html>'), 'image/png')).status, 415);
  const bytes = Buffer.from('<script>document.cookie</script>');
  const file = (await owner.upload('Résumé (2).txt', bytes)).data.file;
  const r = await owner.call(file.url);
  assert.equal(r.status, 200); assert.deepEqual(r.bytes, bytes);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.match(r.headers.get('content-disposition'), /^attachment;/);
  assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8''R%C3%A9sum%C3%A9/);
  const head = await owner.call(file.url, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); assert.equal(Number(head.headers.get('content-length')), bytes.length);
});

test('malformed names, MIME mismatches, empty files, encoding and text bytes are rejected', async t => {
  const f = await fixture(); t.after(() => f.app.close()); const owner = await f.guest('Owner');
  for (const name of ['../notes.txt','path/notes.txt','path\\notes.txt','.hidden.txt',' notes.txt','notes.txt ','notes\n.txt','bad\u202etxt.txt', 'a'.repeat(161) + '.txt']) {
    assert.equal((await owner.upload(name)).status, 400, name);
  }
  assert.equal((await owner.upload('notes.txt', Buffer.from('ok'), 'text/plain', 'commons', {'X-File-Name':'bad%ZZ.txt'})).status, 400);
  assert.equal((await owner.upload('notes.txt', Buffer.from('ok'), 'text/plain; charset=utf-8')).status, 400);
  assert.equal((await owner.upload('notes.txt', Buffer.from('ok'), 'text/html')).status, 415);
  assert.equal((await owner.upload('notes.txt', Buffer.alloc(0))).status, 400);
  assert.equal((await owner.upload('notes.txt', Buffer.from([255,255]))).status, 415);
  assert.equal((await owner.upload('notes.txt', Buffer.from([0,1]))).status, 415);
  assert.equal((await owner.upload('notes.txt', Buffer.from('ok'), 'text/plain', 'commons', {'Content-Encoding':'gzip'})).status, 415);
  assert.equal((await owner.call('/api/rooms/commons/files','POST', {name:'notes.txt',url:'https://example.org'})).status, 415);
  assert.equal((await owner.call('/api/rooms/commons/files')).data.files.length, 0);
});

function rawRequest(f, cookie, headers, write) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host:'127.0.0.1', port:f.port, path:'/api/rooms/commons/files', method:'POST', headers: { Cookie:cookie, 'Content-Type':'application/octet-stream', 'X-File-Name':'notes.txt', 'X-File-Type':'text/plain', ...headers } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({status:res.statusCode, data:JSON.parse(body)}));
    });
    req.on('error', reject); write(req);
  });
}

test('declared and chunked oversized uploads return 413 with no bytes stored', async t => {
  const f = await fixture(); t.after(() => f.app.close()); const owner = await f.guest('Owner');
  assert.equal((await owner.upload('large.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 65))).status, 413);
  const chunked = await rawRequest(f, owner.cookie, {'Transfer-Encoding':'chunked'}, req => { req.write(Buffer.alloc(MAX_FILE_BYTES, 65)); req.end('X'); });
  assert.equal(chunked.status, 413);
  assert.equal((await owner.call('/api/rooms/commons/files')).data.files.length, 0);
});

test('in-flight upload rechecks editor permissions after the request body arrives', async t => {
  const f = await fixture(); t.after(() => f.app.close()); const owner = await f.guest('Owner'), editor = await f.guest('Editor');
  await owner.call(`/api/rooms/commons/members/${editor.user.id}`, 'PUT', {role:'editor'});
  const authorize = f.app.store.authorize.bind(f.app.store);
  let observed; const initialAuthorization = new Promise(resolve => observed = resolve);
  f.app.store.authorize = (roomId, userId, roles) => { const auth = authorize(roomId, userId, roles); if (userId === editor.user.id && roles?.includes('editor')) observed(); return auth; };
  let upload;
  const result = rawRequest(f, editor.cookie, {'Transfer-Encoding':'chunked'}, req => { upload = req; req.write('start'); });
  await initialAuthorization;
  await owner.call(`/api/rooms/commons/members/${editor.user.id}`, 'PUT', {role:'member'});
  upload.end('end'); assert.equal((await result).status, 403);
  assert.equal((await owner.call('/api/rooms/commons/files')).data.files.length, 0);
});

test('delete is recoverable, hidden from ordinary lists and restore requires an editor', async t => {
  const f = await fixture(); t.after(() => f.app.close()); const owner = await f.guest('Owner'), member = await f.guest('Member'); await joinRoom(member);
  const file = (await owner.upload()).data.file;
  const removed = await owner.call(file.url, 'DELETE'); assert.equal(removed.status, 200); assert.ok(removed.data.file.deletedAt);
  assert.equal((await owner.call(file.url)).status, 404);
  assert.equal((await owner.call('/api/rooms/commons/files')).data.files.length, 0);
  assert.equal((await member.call('/api/rooms/commons/files?includeDeleted=1')).status, 403);
  assert.equal((await owner.call('/api/rooms/commons/files?includeDeleted=1')).data.files[0].id, file.id);
  assert.equal((await member.call(file.url + '/restore', 'POST')).status, 403);
  assert.equal((await owner.call(file.url + '/restore', 'POST')).data.file.deletedAt, null);
  assert.equal((await member.call(file.url)).bytes.toString(), 'Hello document');
});

test('SQLite restart keeps bytes, metadata, scene document links, ACL and tombstones', async t => {
  const dir = await mkdtemp(join(tmpdir(),'universe-files-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const database = join(dir,'files.sqlite'); let f = await fixture(database); const owner = await f.guest('Owner'), member = await f.guest('Member'); await joinRoom(member);
  const file = (await owner.upload('durable.txt', Buffer.from('bytes survive restart'))).data.file;
  const removed = (await owner.upload('removed.txt')).data.file; await owner.call(removed.url,'DELETE');
  const { room } = (await owner.call('/api/rooms/commons')).data;
  room.scene.objects[0].url = file.url; room.scene.objects[0].name = file.name;
  assert.equal((await owner.call('/api/rooms/commons/scene','PUT',{revision:room.revision,scene:room.scene})).status, 200);
  const ownerCookie = owner.cookie, memberCookie = member.cookie; await f.app.close();
  f = await fixture(database); t.after(() => f.app.close());
  const recovered = f.client(ownerCookie), reader = f.client(memberCookie);
  assert.equal((await reader.call(file.url)).bytes.toString(), 'bytes survive restart');
  assert.deepEqual((await recovered.call('/api/rooms/commons/files')).data.files[0],file);
  assert.equal((await recovered.call('/api/rooms/commons')).data.room.scene.objects[0].url,file.url);
  assert.equal((await recovered.call(removed.url)).status,404);
  assert.equal((await reader.upload()).status,403);
  assert.equal((await recovered.call(removed.url + '/restore','POST')).status,200);
});

test('file count quotas include recoverable tombstones and uploading never fetches external URLs', async t => {
  const f = await fixture(); t.after(() => f.app.close()); const owner = await f.guest('Owner');
  const file = (await owner.upload()).data.file;
  for (let i = 1; i < MAX_ROOM_FILES; i++) f.app.store.run('INSERT INTO room_files SELECT ?,room_id,name,content_type,size,bytes,sha256,created_by,created_at,? FROM room_files WHERE id=?',`quota-${i}`,Date.now(),file.id);
  assert.equal((await owner.upload()).status,409);
  assert.equal((await owner.call('/api/rooms/commons/files')).data.files.length,1);
});
