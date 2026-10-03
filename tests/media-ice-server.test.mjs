// Synthetic config/secrets and deterministic policy clocks only. HTTP uses fresh
// in-memory createGameServer instances on loopback. No relay, device, credential
// service, or deployment is contacted; configured URLs use the discard port.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {PassThrough} from 'node:stream';
import {createHash, createHmac, randomBytes} from 'node:crypto';
import {createGameServer} from '../server/app.mjs';
import {createMediaPolicy} from '../server/media.mjs';
import {createMediaIce, readIceRelayConfig, readIceBody, ICE_BODY_LIMIT, ICE_BODY_TIMEOUT_MS} from '../server/media-ice.mjs';
import {seedWorlds} from '../src/worlds.js';

const INITIAL_TIME = 1_800_000_000_250;
const requestId = () => randomBytes(18).toString('base64url');
const randomScope = () => randomBytes(32).toString('base64url');
const syntheticSecret = () => randomBytes(48).toString('base64url');
const bodyFor = scope => ({scope, requestId: requestId()});
const isFailure = (status, code) => error => error?.status === status && error?.code === code;
const assertFailure = (response, status, code) => {
  assert.equal(response.status, status);
  assert.equal(response.data.code, code);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(Object.hasOwn(response.data, 'iceServers'), false);
};
const relayConfig = (extra = {}) => {
  const secret = syntheticSecret();
  return {secret, config: readIceRelayConfig({
    MEDIA_STUN_URLS: 'stun:127.0.0.1:9',
    MEDIA_TURN_URLS: 'turn:127.0.0.1:9?transport=udp,turns:[::1]:9?transport=tcp',
    MEDIA_TURN_SHARED_SECRET: secret,
    MEDIA_ICE_TTL_SECONDS: '120', MEDIA_ICE_RENEWAL_SECONDS: '60', ...extra,
  })};
};

function unitFixture({config = relayConfig().config, areas = [], role = 'owner'} = {}) {
  let time = INITIAL_TIME, visible = true;
  const records = new Map(), presence = new Map();
  const store = {
    get(_sql, token, at) {const row = records.get(token); return row && row.expires_at > at ? {...row} : undefined;},
    roomRow(roomId) {return {id: roomId};},
    canSeeRoom() {return visible;},
    room() {return {scene: {areas}, role};},
    authorize() {if (!visible) throw Object.assign(new Error('ROOM_FORBIDDEN'), {status:403, code:'ROOM_FORBIDDEN'}); return {role};},
  };
  const media = createMediaPolicy({store, presence, now: () => time, emitUser() {}});
  const ice = createMediaIce({config, store, presence, media, now: () => time});
  function add(userId = 'user-a', roomId = 'room-a') {
    const s = {token_hash: randomScope(), user_id: userId, current_room_id: roomId, expires_at: time + 3_600_000};
    records.set(s.token_hash, s);
    if (roomId) presence.set(`${roomId}:${userId}`, {userId, name:userId, roomId, x:0, z:0, moving:false, status:'online', lastSeen:time});
    return s;
  }
  const s = add();
  const policy = (session = s) => ice.decorate(session, media.policy(session.user_id, session.current_room_id));
  const optIn = (session = s, enabled = true) => {ice.optIn(session, enabled); media.state(session.user_id, session.current_room_id, enabled); return policy(session);};
  return {ice, media, store, records, presence, s, add, policy, optIn, config,
    get time() {return time;}, advance(ms) {time += ms;}, hide() {visible = false;},
    move(fields, session = s) {Object.assign(presence.get(`${session.current_room_id}:${session.user_id}`), fields);},
  };
}

async function httpFixture(t, {config = relayConfig().config} = {}) {
  let time = INITIAL_TIME;
  const app = createGameServer({database:':memory:', seeds:seedWorlds, clock:() => time, questsEnabled:false, iceRelayConfig:config});
  t.after(() => app.close());
  const {port} = await app.listen(0), base = `http://127.0.0.1:${port}`;
  const client = (cookie = '') => ({cookie, async call(path, method = 'GET', body, headers = {}) {
    const response = await fetch(base + path, {method, headers:{...(this.cookie ? {Cookie:this.cookie} : {}), ...(body === undefined ? {} : {'Content-Type':'application/json'}), ...headers}, body:body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)});
    if (response.headers.get('set-cookie')) this.cookie = response.headers.get('set-cookie').split(';')[0];
    const text = await response.text();
    return {status:response.status, headers:response.headers, data:text ? JSON.parse(text) : null, text};
  }});
  async function guest(name = 'Local fixture') {
    const c = client(), response = await c.call('/api/session', 'POST', {name, woka:1});
    assert.equal(response.status, 201); c.user = response.data.user; return c;
  }
  async function join(c, room = 'commons') {assert.equal((await c.call(`/api/rooms/${room}/join`, 'POST', {})).status, 200);}
  async function optIn(c) {const response = await c.call('/api/media/state', 'POST', {enabled:true}); assert.equal(response.status, 200); return response.data;}
  async function joined(c, room = 'commons') {await join(c, room); return optIn(c);}
  const tokenHash = c => createHash('sha256').update(c.cookie.split('=')[1]).digest('hex');
  return {app, port, base, config, client, guest, join, optIn, joined, tokenHash,
    get time() {return time;}, advance(ms) {time += ms;},
    expiry(c, expiresAt) {app.store.run('UPDATE sessions SET expires_at=? WHERE token_hash=?', expiresAt, tokenHash(c));},
    sameUserSession(c) {
      const token = randomScope(), hash = createHash('sha256').update(token).digest('hex');
      app.store.run('INSERT INTO sessions(token_hash,user_id,expires_at,current_room_id) VALUES(?,?,?,?)', hash, c.user.id, time+3_600_000, 'commons');
      const second = client(`universe_session=${token}`); second.user = c.user; return second;
    },
  };
}

async function heldBody(f, c, body) {
  let acknowledge;
  const arrived = new Promise(resolve => {acknowledge = resolve;});
  const listener = req => {
    // Observe listener installation without consuming the request stream before
    // the app has completed its earlier async route checks.
    if (req.url === '/api/media/ice') req.on('newListener', (name, handler) => {
      if(name==='data' && handler.name==='data')setImmediate(acknowledge);
    });
  };
  f.app.server.prependListener('request', listener);
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(`${f.base}/api/media/ice`, {method:'POST', headers:{Cookie:c.cookie, 'Content-Type':'application/json'}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({status:res.statusCode, headers:new Headers(res.headers), data:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
    });
    request.on('error', reject); request.flushHeaders();
  });
  await arrived;
  f.app.server.off('request', listener);
  request.write('{');
  return {response, finish() {request.end(JSON.stringify(body).slice(1));}, destroy() {request.destroy();}};
}

async function eventStream(t, f, c) {
  const controller=new AbortController(), events=[], waiters=new Set();
  const response=await fetch(`${f.base}/api/events`,{headers:{Cookie:c.cookie},signal:controller.signal});
  assert.equal(response.status,200);
  const reader=response.body.getReader(), decoder=new TextDecoder();let buffer='', raw='';
  const reading=(async () => {
    try {
      for(;;) {
        const {value,done}=await reader.read();if(done)break;
        const text=decoder.decode(value,{stream:true});buffer+=text;raw+=text;
        let index;
        while((index=buffer.indexOf('\n\n'))>=0) {
          const block=buffer.slice(0,index);buffer=buffer.slice(index+2);
          const event=block.match(/^event: (.+)$/m)?.[1], data=block.match(/^data: (.+)$/m)?.[1];
          if(event&&data) {
            const item={event,data:JSON.parse(data)};events.push(item);
            for(const check of [...waiters])check();
          }
        }
      }
    } catch(error) {if(error.name!=='AbortError')throw error;}
  })();
  t.after(async () => {controller.abort();await reading;});
  return {events,get raw(){return raw;},wait(predicate,after=0) {
    const find=() => events.slice(after).find(predicate), prior=find();if(prior)return Promise.resolve(prior);
    return new Promise((resolve,reject) => {
      const timeout=setTimeout(() => {waiters.delete(check);reject(new Error('Expected local SSE policy did not arrive'));},2000);
      const check=() => {const found=find();if(found){clearTimeout(timeout);waiters.delete(check);resolve(found);}};
      waiters.add(check);check();
    });
  }};
}

test('ICE config defaults are host-only, immutable, and never serialize relay secrets', () => {
  const defaults = readIceRelayConfig({});
  assert.deepEqual(defaults, {stunUrls:[], turnUrls:[], ttlSeconds:14400, renewalSeconds:10800});
  const {config, secret} = relayConfig();
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.stunUrls), true);
  assert.equal(Object.isFrozen(config.turnUrls), true);
  assert.equal(JSON.stringify(config).includes(secret), false, 'config must not serialize the synthetic shared secret');
  assert.deepEqual(Object.keys(config).sort(), ['renewalSeconds', 'stunUrls', 'ttlSeconds', 'turnUrls']);
  assert.throws(() => createMediaIce({config:{...config}}), /^Error: Invalid media ICE configuration$/);
});

test('ICE config accepts explicit bounded STUN/TURN URLs and removes identical entries', () => {
  const secret = syntheticSecret();
  const config = readIceRelayConfig({MEDIA_STUN_URLS:'stun:127.0.0.1:9, stuns:[::1]:9,stun:127.0.0.1:9', MEDIA_TURN_URLS:'turn:127.0.0.1:9,turn:[::1]:9?transport=tcp,turns:localhost:9', MEDIA_TURN_SHARED_SECRET:secret});
  assert.equal(config.stunUrls.length, 2); assert.equal(config.turnUrls.length, 3);
});

test('ICE config rejects unsafe URL/protocol combinations, static credentials, and invalid TTL/renewal bounds', () => {
  const secret = syntheticSecret();
  const invalidStun = [null, [], 'https://127.0.0.1:9', 'turn:127.0.0.1:9', 'stun://127.0.0.1:9', 'stun:127.0.0.1:9?transport=udp', 'stun:127.0.0.1:0', 'stun:127.0.0.1:65536', 'stun:127.0.0.1/path', 'stun:user@127.0.0.1:9', 'stun:127.0.0.1:9#x', 'stun:bad_host:9', 'stun:[:::]:9', 'stun:127.0.0.1:9,', 'stun:127.0.0.1:9\n?x', Array(9).fill('stun:127.0.0.1:9').join(',')];
  const invalidTurn = ['stun:127.0.0.1:9', 'turns:127.0.0.1:9?transport=udp', 'turn:127.0.0.1:9?transport=quic', 'turn:127.0.0.1:9?transport=tcp&x=1', 'turn:user:pass@127.0.0.1:9', 'turn:127.0.0.1:9/path'];
  for (const value of invalidStun) assert.throws(() => readIceRelayConfig({MEDIA_STUN_URLS:value}), /^Error: Invalid media ICE configuration$/);
  for (const value of invalidTurn) assert.throws(() => readIceRelayConfig({MEDIA_TURN_URLS:value, MEDIA_TURN_SHARED_SECRET:secret}), /^Error: Invalid media ICE configuration$/);
  for (const env of [
    {MEDIA_TURN_USERNAME:''}, {MEDIA_TURN_PASSWORD:''}, {MEDIA_TURN_SHARED_SECRET:secret},
    {MEDIA_TURN_URLS:'turn:127.0.0.1:9'},
    {MEDIA_TURN_URLS:'turn:127.0.0.1:9', MEDIA_TURN_SHARED_SECRET:secret.slice(0,31)},
    {MEDIA_TURN_URLS:'turn:127.0.0.1:9', MEDIA_TURN_SHARED_SECRET:secret+'\n'},
    {MEDIA_TURN_URLS:'turn:127.0.0.1:9', MEDIA_TURN_SHARED_SECRET:randomBytes(400).toString('hex')},
    ...['59','14401','1e3','120.5','-120',120].map(value => ({MEDIA_ICE_TTL_SECONDS:value})),
    ...['29','106','120','NaN'].map(value => ({MEDIA_ICE_TTL_SECONDS:'120', MEDIA_ICE_RENEWAL_SECONDS:value})),
  ]) assert.throws(() => readIceRelayConfig(env), /^Error: Invalid media ICE configuration$/);
});

test('issued ICE uses authenticated user and fresh scope, session-capped timestamps, and HMAC credentials', () => {
  const {config, secret} = relayConfig(), f = unitFixture({config});
  f.s.expires_at = f.time + 65_875;
  const policy = f.optIn(), body = bodyFor(policy.iceScope), result = f.ice.issue(f.s, body);
  assert.deepEqual(Object.keys(result).sort(), ['expiresAt','iceServers','issuedAt','renewAt','requestId','roomId','scope','selfId','transport']);
  assert.equal(result.scope, policy.iceScope); assert.equal(result.requestId, body.requestId);
  assert.equal(result.selfId, f.s.user_id); assert.equal(result.roomId, f.s.current_room_id);
  assert.equal(result.issuedAt, f.time); assert.equal(result.expiresAt, Math.floor(f.s.expires_at/1000)*1000);
  assert.equal(result.renewAt, f.time+Math.floor((result.expiresAt-f.time)*.75));
  assert.equal(result.transport, 'relay-configured');
  const turn = result.iceServers[1];
  assert.equal(turn.username === `${Math.floor(result.expiresAt/1000)}:${f.s.user_id}`, true, 'TURN username must carry capped expiry and authenticated user');
  assert.equal(turn.credential === createHmac('sha1',secret).update(turn.username).digest('base64'), true, 'credential must match the synthetic server-only secret');
  assert.equal(turn.credentialType, 'password');
  assert.equal(JSON.stringify(result).includes(secret), false, 'response must not serialize the synthetic shared secret');
  assert.deepEqual(f.policy().iceServers, [], 'ordinary policy never contains dynamic credentials');
});

test('TTL caps long sessions and short expiring sessions fail closed', () => {
  const f = unitFixture(), p = f.optIn(), body = bodyFor(p.iceScope);
  const result = f.ice.issue(f.s, body);
  assert.equal(result.expiresAt, Math.floor((f.time+120_000)/1000)*1000);
  assert.equal(result.renewAt, f.time+60_000);
  f.s.expires_at = f.time+1500;
  assert.throws(() => f.ice.issue(f.s, body), isFailure(401,'ICE_SESSION_EXPIRING'));
  f.s.expires_at = f.time;
  assert.throws(() => f.ice.issue(f.s, body), isFailure(403,'ICE_SCOPE_FORBIDDEN'));
});

test('host-only and STUN-only issue honest configurations without static TURN fallback', () => {
  for (const [env, transport, count] of [[{}, 'host-only', 0], [{MEDIA_STUN_URLS:'stun:127.0.0.1:9'}, 'stun-configured', 1]]) {
    const f = unitFixture({config:readIceRelayConfig(env)}), p = f.optIn(), result = f.ice.issue(f.s, bodyFor(p.iceScope));
    assert.equal(result.transport, transport); assert.equal(result.iceServers.length, count);
    assert.equal(result.iceServers.some(server => 'credential' in server || 'username' in server), false);
  }
});

test('scope remains stable within one context, rotates on opt-in/context transitions, and binds each cookie session', () => {
  const f = unitFixture({areas:[{id:'meeting-a',action:'meeting',x:5,z:0,width:2,depth:2}]}), first = f.optIn().iceScope;
  assert.match(first, /^[A-Za-z0-9_-]{43}$/); assert.equal(f.policy().iceScope, first);
  const secondSession = f.add();
  assert.equal(f.policy(secondSession).iceScope, undefined, 'another cookie never inherits opt-in');
  assert.throws(() => f.ice.issue(secondSession, bodyFor(first)), isFailure(403,'ICE_SCOPE_FORBIDDEN'));
  const second = f.optIn(secondSession).iceScope;
  assert.equal(second !== first, true, 'same-user cookies must receive independent scopes');
  assert.throws(() => f.ice.issue(secondSession, bodyFor(first)), isFailure(403,'ICE_SCOPE_FORBIDDEN'));
  const other = f.add('user-b'); f.optIn(other);
  assert.throws(() => f.ice.issue(other, bodyFor(first)), isFailure(403,'ICE_SCOPE_FORBIDDEN'));
  f.move({x:5}); const meeting = f.policy().iceScope;
  assert.equal(meeting !== first, true); assert.throws(() => f.ice.issue(f.s, bodyFor(first)), isFailure(403,'ICE_SCOPE_FORBIDDEN'));
  f.optIn(f.s, false); assert.equal(f.policy().iceScope, undefined);
  const renewed = f.optIn().iceScope; assert.equal(renewed !== meeting, true);
  f.ice.retireUser('user-a'); assert.equal(f.policy().iceScope, undefined); assert.equal(f.policy(secondSession).iceScope, undefined);
});

test('unit policy denies missing opt-in/room, Silent, blocked proximity, wrong scope/identity, missing or stale presence, revocation, and retired sessions', () => {
  for (const mutate of [
    f => f.ice.optIn(f.s,false),
    f => {f.s.current_room_id=null;},
    f => f.move({status:'busy'}),
    f => f.move({status:'dnd'}),
    f => f.move({status:'invisible'}),
    f => f.presence.clear(),
    f => f.advance(60_000),
    f => f.records.delete(f.s.token_hash),
    f => f.ice.retire(f.s.token_hash),
  ]) {
    const f=unitFixture(), p=f.optIn(); mutate(f);
    assert.equal(f.policy().iceScope,undefined);
    assert.throws(() => f.ice.issue(f.s,bodyFor(p.iceScope)),isFailure(403,'ICE_SCOPE_FORBIDDEN'));
  }
  const quiet=unitFixture({areas:[{id:'quiet',action:'silent',x:5,z:0,width:2,depth:2}]}), before=quiet.optIn();
  quiet.move({x:5}); assert.equal(quiet.policy().context.kind,'silent'); assert.equal(quiet.policy().iceScope,undefined);
  assert.throws(() => quiet.ice.issue(quiet.s,bodyFor(before.iceScope)),isFailure(403,'ICE_SCOPE_FORBIDDEN'));
  quiet.move({x:0}); assert.equal(quiet.policy().iceScope !== before.iceScope,true);
  const f=unitFixture(), p=f.optIn();
  assert.throws(() => f.ice.issue(f.s,bodyFor(randomScope())),isFailure(403,'ICE_SCOPE_FORBIDDEN'));
  assert.equal(f.ice.decorate({...f.s,user_id:'different-user'}, {...p,selfId:'different-user'}).iceScope,undefined);
  f.hide(); assert.throws(() => f.ice.issue(f.s,bodyFor(p.iceScope)),isFailure(403,'ROOM_FORBIDDEN'));
});

test('receive-only audience and denied stage publishing remain transport-eligible; the directed graph is unchanged', () => {
  for (const action of ['audience','stage']) {
    const f=unitFixture({role:'guest',areas:[{id:'listen',action,x:0,z:0,width:5,depth:5,meetingName:'group'}]});
    const p=f.optIn(); assert.equal(p.context.canPublish,false); assert.match(p.iceScope,/^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(p.peers,[]); assert.equal(f.ice.issue(f.s,bodyFor(p.iceScope)).transport,'relay-configured');
  }
});

test('unit rate limits bound sessions and users, survive opt-in toggling, and reopen only at the next window', () => {
  const f=unitFixture();
  for(let i=0;i<8;i++) f.ice.begin(f.s);
  assert.throws(() => f.ice.begin(f.s),isFailure(429,'ICE_RATE_LIMITED'));
  const second=f.add(), third=f.add();
  for(let i=0;i<8;i++)f.ice.begin(second);
  for(let i=0;i<4;i++)f.ice.begin(third);
  assert.throws(() => f.ice.begin(third),isFailure(429,'ICE_RATE_LIMITED'));
  f.ice.optIn(f.s,false); f.ice.optIn(f.s,true);
  assert.throws(() => f.ice.begin(f.s),isFailure(429,'ICE_RATE_LIMITED'));
  f.advance(59_999);assert.throws(() => f.ice.begin(second),isFailure(429,'ICE_RATE_LIMITED'));
  f.advance(1);assert.doesNotThrow(() => f.ice.begin(second));
});

test('the per-session rate counter survives opt-out, opt-in, and retirement independently of the user ceiling', () => {
  const f=unitFixture();f.optIn();
  for(let i=0;i<8;i++)f.ice.begin(f.s);
  f.optIn(f.s,false);f.optIn();
  assert.throws(() => f.ice.begin(f.s),isFailure(429,'ICE_RATE_LIMITED'));
  f.ice.retire(f.s.token_hash);f.optIn();
  assert.throws(() => f.ice.begin(f.s),isFailure(429,'ICE_RATE_LIMITED'));
  f.advance(60_000);assert.doesNotThrow(() => f.ice.begin(f.s));
});

test('scope and rate storage hit finite capacity and expire instead of growing without bound', () => {
  const f=unitFixture();
  for(let i=0;i<2048;i++)f.ice.optIn(f.add(`capacity-${i}`),true);
  assert.throws(() => f.ice.optIn(f.s,true),isFailure(503,'ICE_CAPACITY'));
  f.advance(60_000);f.move({lastSeen:f.time});
  assert.doesNotThrow(() => f.ice.optIn(f.s,true));
  const rates=unitFixture();
  for(let i=0;i<2048;i++)rates.ice.begin(rates.add(`rate-${i}`));
  assert.throws(() => rates.ice.begin(rates.s),isFailure(503,'ICE_CAPACITY'));
  rates.advance(60_000);assert.doesNotThrow(() => rates.ice.begin(rates.s));
});

const requestStream = (headers = {'content-type':'application/json'}) => Object.assign(new PassThrough(), {headers});
test('ICE body admits exactly scope/requestId and rejects malformed or caller-controlled fields', async () => {
  const valid=bodyFor(randomScope());
  const req=requestStream();const accepted=readIceBody(req);req.end(JSON.stringify(valid));assert.deepEqual(await accepted,valid);
  for (const value of [{...valid,userId:'other'},{...valid,roomId:'other'},{...valid,iceServers:[]},{...valid,ttlSeconds:14400},{scope:valid.scope},{requestId:valid.requestId},{...valid,scope:'x'.repeat(42)},{...valid,scope:'x'.repeat(44)},{...valid,requestId:'x'.repeat(15)},{...valid,requestId:'x'.repeat(97)},{...valid,scope:1},{...valid,requestId:'invalid space id'},null,[],1]) {
    const req=requestStream(), pending=readIceBody(req);req.end(JSON.stringify(value));
    await assert.rejects(pending,error => error.status===400 && ['INVALID_INPUT','INVALID_ICE_REQUEST'].includes(error.code));
  }
  const malformed=requestStream(), pending=readIceBody(malformed);malformed.end('{');await assert.rejects(pending,isFailure(400,'INVALID_JSON'));
});

test('ICE body enforces JSON, declared/streamed byte limits, and an exact elapsed deadline', async t => {
  for(const headers of [{},{'content-type':'text/plain'},{'content-type':'application/jsonp'}])await assert.rejects(readIceBody(requestStream(headers)),isFailure(415,'JSON_REQUIRED'));
  for(const length of ['-1','garbage',String(ICE_BODY_LIMIT+1)])await assert.rejects(readIceBody(requestStream({'content-type':'application/json','content-length':length})),isFailure(413,'ICE_BODY_TOO_LARGE'));
  const oversized=requestStream(), exceeded=readIceBody(oversized);oversized.end('x'.repeat(ICE_BODY_LIMIT+1));await assert.rejects(exceeded,isFailure(413,'ICE_BODY_TOO_LARGE'));
  const exact=requestStream(), valid=bodyFor(randomScope()), text=JSON.stringify(valid), result=readIceBody(exact);exact.end(text+' '.repeat(ICE_BODY_LIMIT-Buffer.byteLength(text)));assert.deepEqual(await result,valid);
  t.mock.timers.enable({apis:['setTimeout']});
  const held=requestStream(), timeout=readIceBody(held);let settled=false;timeout.then(() => {settled=true;},() => {settled=true;});
  const rejected=assert.rejects(timeout,isFailure(408,'ICE_BODY_TIMEOUT'));
  t.mock.timers.tick(ICE_BODY_TIMEOUT_MS-1);await Promise.resolve();assert.equal(settled,false);
  t.mock.timers.tick(1);await rejected;
  assert.equal(held.listenerCount('data'),0);assert.equal(held.listenerCount('end'),0);held.end();
});

test('ICE body abort retires listeners and cannot become a later successful request', async () => {
  const req=requestStream(), pending=readIceBody(req);const rejected=assert.rejects(pending,isFailure(400,'ICE_BODY_ABORTED'));
  req.emit('aborted');await rejected;assert.equal(req.listenerCount('data'),0);assert.equal(req.listenerCount('end'),0);req.end(JSON.stringify(bodyFor(randomScope())));
});

test('HTTP ICE requires cookie auth, exact body, current opt-in, and noncacheable responses', async t => {
  const {config,secret}=relayConfig(), f=await httpFixture(t,{config}), a=await f.guest();
  assertFailure(await f.client().call('/api/media/ice','POST',bodyFor(randomScope())),401,'AUTH_REQUIRED');
  assertFailure(await a.call('/api/media/ice','POST',bodyFor(randomScope())),403,'ICE_SCOPE_FORBIDDEN');
  await f.join(a);assert.equal((await a.call('/api/media')).data.iceScope,undefined);
  assertFailure(await a.call('/api/media/ice','POST',bodyFor(randomScope())),403,'ICE_SCOPE_FORBIDDEN');
  const p=await f.optIn(a), body=bodyFor(p.iceScope), response=await a.call('/api/media/ice','POST',body);
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('pragma'),'no-cache');
  assert.equal(response.data.scope,body.scope);assert.equal(response.data.requestId,body.requestId);assert.equal(response.data.selfId,a.user.id);assert.equal(response.data.roomId,'commons');
  assert.equal(response.text.includes(secret),false,'synthetic shared secret must not appear in HTTP');
  assert.deepEqual((await a.call('/api/media')).data.iceServers,[]);
  assertFailure(await a.call('/api/media/ice','POST',{...body,userId:a.user.id}),400,'INVALID_ICE_REQUEST');
  assertFailure(await a.call('/api/media/ice','POST',{...body,roomId:'commons'}),400,'INVALID_ICE_REQUEST');
  assertFailure(await a.call('/api/media/ice','POST',{...body,iceServers:[]}),400,'INVALID_ICE_REQUEST');
  assertFailure(await a.call('/api/media/ice','POST',body,{'Content-Type':'text/plain'}),415,'JSON_REQUIRED');
});

test('HTTP scope cannot cross users or cookie sessions, even when the second cookie shares one user', async t => {
  const f=await httpFixture(t), a=await f.guest('A'), b=await f.guest('B');
  const p=await f.joined(a);await f.joined(b);
  assertFailure(await b.call('/api/media/ice','POST',bodyFor(p.iceScope)),403,'ICE_SCOPE_FORBIDDEN');
  const other=f.sameUserSession(a);
  assert.equal((await other.call('/api/media')).data.iceScope,undefined);
  assertFailure(await other.call('/api/media/ice','POST',bodyFor(p.iceScope)),403,'ICE_SCOPE_FORBIDDEN');
  const own=await f.optIn(other);assert.equal(own.iceScope!==p.iceScope,true);
  assertFailure(await other.call('/api/media/ice','POST',bodyFor(p.iceScope)),403,'ICE_SCOPE_FORBIDDEN');
  assert.equal((await other.call('/api/media/ice','POST',bodyFor(own.iceScope))).status,200);
  const spoof=await b.call('/api/media/ice','POST',bodyFor(p.iceScope),{'X-User-Id':a.user.id});assertFailure(spoof,403,'ICE_SCOPE_FORBIDDEN');
});

test('real separate-cookie SSE streams retain per-session scope parity with GET and never carry credentials', async t => {
  const {config,secret}=relayConfig(), f=await httpFixture(t,{config}), a=await f.guest();await f.joined(a);
  const b=f.sameUserSession(a), streamA=await eventStream(t,f,a), streamB=await eventStream(t,f,b);
  await streamA.wait(item => item.event==='hello');await streamB.wait(item => item.event==='hello');
  const initialB=(await b.call('/api/media')).data;assert.equal(initialB.iceScope,undefined);
  await f.optIn(b);
  const getA=(await a.call('/api/media')).data, getB=(await b.call('/api/media')).data;
  assert.equal(getA.iceScope!==getB.iceScope,true,'each cookie must own an independent scope');
  const pushA=await streamA.wait(item => item.event==='media-policy'&&item.data.iceScope===getA.iceScope);
  const pushB=await streamB.wait(item => item.event==='media-policy'&&item.data.iceScope===getB.iceScope);
  assert.equal(pushA.data.selfId,a.user.id);assert.equal(pushB.data.selfId,a.user.id);
  assert.equal(pushA.data.roomId,'commons');assert.equal(pushB.data.roomId,'commons');
  assertFailure(await a.call('/api/media/ice','POST',bodyFor(getB.iceScope)),403,'ICE_SCOPE_FORBIDDEN');
  assertFailure(await b.call('/api/media/ice','POST',bodyFor(getA.iceScope)),403,'ICE_SCOPE_FORBIDDEN');
  assert.equal((await a.call('/api/media')).data.iceScope===getA.iceScope,true,'cross-cookie attempt cannot replace the legitimate scope');
  assert.equal((await b.call('/api/media')).data.iceScope===getB.iceScope,true,'cross-cookie attempt cannot replace the legitimate scope');
  assert.equal((await a.call('/api/media/ice','POST',bodyFor(getA.iceScope))).status,200);
  assert.equal((await b.call('/api/media/ice','POST',bodyFor(getB.iceScope))).status,200);
  const markA=streamA.events.length,markB=streamB.events.length;
  assert.equal((await a.call('/api/me','PATCH',{status:'busy'})).status,200);
  for(const [stream,mark]of [[streamA,markA],[streamB,markB]]) {
    const denied=await stream.wait(item => item.event==='media-policy'&&item.data.context.canPublish===false,mark);
    assert.equal(denied.data.iceScope,undefined);
  }
  assert.equal((await a.call('/api/me','PATCH',{status:'online'})).status,200);
  const freshA=(await a.call('/api/media')).data, freshB=(await b.call('/api/media')).data;
  assert.equal(freshA.iceScope!==getA.iceScope,true);assert.equal(freshB.iceScope!==getB.iceScope,true);
  assert.equal(freshA.iceScope!==freshB.iceScope,true);
  await streamA.wait(item => item.event==='media-policy'&&item.data.iceScope===freshA.iceScope,markA);
  await streamB.wait(item => item.event==='media-policy'&&item.data.iceScope===freshB.iceScope,markB);
  for(const stream of [streamA,streamB]) {
    const policies=stream.events.filter(item => item.event==='media-policy');assert.equal(policies.length>0,true);
    for(const {data}of policies) {
      assert.deepEqual(data.iceServers,[],'SSE may carry authority, never TURN credentials');
      assert.equal(/"(?:credential|username|credentialType)"\s*:/.test(JSON.stringify(data)),false,'media policy must not serialize relay credential fields');
    }
    assert.equal(stream.raw.includes(secret),false,'synthetic shared secret must not appear in SSE');
    // The hello user profile legitimately includes its local-account username.
    assert.equal(/"(?:credential|credentialType)"\s*:/.test(stream.raw),false,'SSE must not serialize any relay credential fields');
  }
});

for (const scenario of ['silent','busy','dnd','invisible','stale','missing','wrong scope','old room','opt out','logout','expired','revoked']) {
  test(`HTTP current authority denies ICE after ${scenario}`, async t => {
    const f=await httpFixture(t), owner=await f.guest('Owner'), a=scenario==='revoked'?await f.guest('Visitor'):owner;
    const p=await f.joined(a), body=bodyFor(p.iceScope);
    if(scenario==='silent')assert.equal((await a.call('/api/presence','POST',{roomId:'commons',x:6,z:-3,moving:false})).status,200);
    if(['busy','dnd','invisible'].includes(scenario))assert.equal((await a.call('/api/me','PATCH',{status:scenario})).status,200);
    if(scenario==='stale')f.advance(60_000);
    if(scenario==='missing')f.app.presence.delete(`commons:${a.user.id}`);
    if(scenario==='wrong scope')body.scope=randomScope();
    if(scenario==='old room')await f.joined(a,'studio');
    if(scenario==='opt out')assert.equal((await a.call('/api/media/state','POST',{enabled:false})).status,200);
    if(scenario==='logout')assert.equal((await a.call('/api/logout','POST')).status,200);
    if(scenario==='expired')f.expiry(a,f.time);
    if(scenario==='revoked')assert.equal((await owner.call('/api/rooms/commons/moderate','POST',{userId:a.user.id,action:'ban'})).status,200);
    const expired=['logout','expired'].includes(scenario);
    assertFailure(await a.call('/api/media/ice','POST',body),expired?401:403,expired?'AUTH_REQUIRED':'ICE_SCOPE_FORBIDDEN');
    if(!expired)assert.equal((await a.call('/api/media')).data.iceScope === p.iceScope,scenario==='wrong scope');
  });
}

test('HTTP expiry caps credentials to the authenticated session and rejects too-short sessions', async t => {
  const f=await httpFixture(t), a=await f.guest(), p=await f.joined(a), body=bodyFor(p.iceScope);
  f.expiry(a,f.time+50_000);
  const response=await a.call('/api/media/ice','POST',body);assert.equal(response.status,200);
  assert.equal(response.data.expiresAt,Math.floor((f.time+50_000)/1000)*1000);
  assert.equal(response.data.renewAt,f.time+Math.floor((response.data.expiresAt-f.time)*.75));
  f.expiry(a,f.time+1500);assertFailure(await a.call('/api/media/ice','POST',body),401,'ICE_SESSION_EXPIRING');
});

for (const scenario of ['room change','Silent','opt out','revoke','expiry']) {
  test(`HTTP reauthorizes a held ICE body after ${scenario}`, async t => {
    const f=await httpFixture(t), owner=await f.guest('Owner'), a=scenario==='revoke'?await f.guest('Visitor'):owner;
    const p=await f.joined(a), held=await heldBody(f,a,bodyFor(p.iceScope));t.after(() => held.destroy());
    if(scenario==='room change')await f.joined(a,'studio');
    if(scenario==='Silent')await a.call('/api/presence','POST',{roomId:'commons',x:6,z:-3,moving:false});
    if(scenario==='opt out')await a.call('/api/media/state','POST',{enabled:false});
    if(scenario==='revoke')await owner.call('/api/rooms/commons/moderate','POST',{userId:a.user.id,action:'ban'});
    if(scenario==='expiry')f.expiry(a,f.time);
    held.finish();assertFailure(await held.response,scenario==='expiry'?401:403,scenario==='expiry'?'AUTH_REQUIRED':'ICE_SCOPE_FORBIDDEN');
  });
}

for (const scenario of ['Silent','meeting','busy']) {
  test(`HTTP away-and-back ${scenario} transition without an SSE subscription never revives the prior scope`, async t => {
    const f=await httpFixture(t), a=await f.guest(), room=scenario==='meeting'?'studio':'commons';
    const p=await f.joined(a,room), held=await heldBody(f,a,bodyFor(p.iceScope));t.after(() => held.destroy());
    // Deliberately perform no policy GET or SSE subscription during the entire
    // round trip: authorization transitions must be observed by the server.
    if(scenario==='busy') {
      assert.equal((await a.call('/api/me','PATCH',{status:'busy'})).status,200);
      assert.equal((await a.call('/api/me','PATCH',{status:'online'})).status,200);
    } else {
      assert.equal((await a.call('/api/presence','POST',{roomId:room,x:scenario==='Silent'?6:0,z:scenario==='Silent'?-3:-1,moving:false})).status,200);
      assert.equal((await a.call('/api/presence','POST',{roomId:room,x:0,z:scenario==='Silent'?7:8,moving:false})).status,200);
    }
    held.finish();assertFailure(await held.response,403,'ICE_SCOPE_FORBIDDEN');
    assertFailure(await a.call('/api/media/ice','POST',bodyFor(p.iceScope)),403,'ICE_SCOPE_FORBIDDEN');
    const fresh=(await a.call('/api/media')).data;
    assert.equal(fresh.context.kind,p.context.kind);assert.equal(fresh.iceScope!==p.iceScope,true);
    assert.equal((await a.call('/api/media/ice','POST',bodyFor(fresh.iceScope))).status,200);
  });
}

test('HTTP opt-in toggles cannot reset the per-cookie rate window', async t => {
  const f=await httpFixture(t), a=await f.guest(), p=await f.joined(a);
  for(let i=0;i<8;i++)assert.equal((await a.call('/api/media/ice','POST',bodyFor(p.iceScope))).status,200);
  assert.equal((await a.call('/api/media/state','POST',{enabled:false})).status,200);
  const fresh=await f.optIn(a);
  assertFailure(await a.call('/api/media/ice','POST',bodyFor(fresh.iceScope)),429,'ICE_RATE_LIMITED');
});

test('HTTP rejects over-limit declared and streamed bodies without issuing credentials', async t => {
  const f=await httpFixture(t), a=await f.guest();await f.joined(a);
  assertFailure(await a.call('/api/media/ice','POST','x'.repeat(ICE_BODY_LIMIT+1)),413,'ICE_BODY_TOO_LARGE');
  const held=await heldBody(f,a,{padding:'x'.repeat(ICE_BODY_LIMIT+1)});t.after(() => held.destroy());held.finish();
  assertFailure(await held.response,413,'ICE_BODY_TOO_LARGE');
});

test('HTTP held body deadline fails closed and returns no-store without requiring the body to finish', {timeout:15_000}, async t => {
  const f=await httpFixture(t), a=await f.guest(), p=await f.joined(a), held=await heldBody(f,a,bodyFor(p.iceScope));t.after(() => held.destroy());
  assertFailure(await held.response,408,'ICE_BODY_TIMEOUT');held.destroy();
});

test('HTTP per-session attempts are bounded, including failures, and recover at the deterministic window', async t => {
  const f=await httpFixture(t), a=await f.guest(), p=await f.joined(a);
  for(let i=0;i<8;i++)assertFailure(await a.call('/api/media/ice','POST',bodyFor(randomScope())),403,'ICE_SCOPE_FORBIDDEN');
  assertFailure(await a.call('/api/media/ice','POST',bodyFor(p.iceScope)),429,'ICE_RATE_LIMITED');
  f.advance(60_000);assert.equal((await a.call('/api/rooms/commons/join','POST',{mode:'resume'})).status,200); // Expired placement recovers through authoritative arrival.
  const renewed=await f.optIn(a);assert.equal((await a.call('/api/media/ice','POST',bodyFor(renewed.iceScope))).status,200);
});

test('cosmetic labels, movement reasons, peer lists and names do not churn structural ICE scope',()=>{const f=unitFixture(),p=f.optIn();const changed={...p,context:{...p.context,label:'Renamed display label',reason:'Moving now'},peers:[{id:'other',lastSeen:f.time,displayName:'Another name'}]};assert.equal(f.ice.decorate(f.s,changed).iceScope,p.iceScope);f.move({name:'Renamed player',moving:true,x:0.25});assert.equal(f.policy().iceScope,p.iceScope);});

test('createGameServer factory never inherits ambient operator ICE environment',async t=>{
  const values={MEDIA_STUN_URLS:'stun:127.0.0.1:9',MEDIA_TURN_URLS:'turn:127.0.0.1:9?transport=udp',MEDIA_TURN_SHARED_SECRET:syntheticSecret()};
  const saved=new Map(Object.keys(values).map(key=>[key,process.env[key]]));
  Object.assign(process.env,values);
  let app;
  try{app=createGameServer({database:':memory:',seeds:seedWorlds,questsEnabled:false});}
  finally{for(const[key,value]of saved)if(value===undefined)delete process.env[key];else process.env[key]=value;}
  t.after(()=>app.close());const {port}=await app.listen(0);let cookie='';
  const call=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${port}`+path,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];assert.equal(r.ok,true);return r.json();};
  await call('/api/session',{name:'Factory fixture',woka:1});await call('/api/rooms/commons/join',{});const p=await call('/api/media/state',{enabled:true});const issued=await call('/api/media/ice',bodyFor(p.iceScope));assert.equal(issued.transport,'host-only');assert.deepEqual(issued.iceServers,[]);
});
