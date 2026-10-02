import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createResidentChatAdapter } from '../server/resident-chat-adapter.mjs';

const MESSAGES = [{ role: 'user', content: 'Hello, resident.' }];
const TOOL = { type: 'function', function: { name: 'look_room', description: 'Read visible room facts.', parameters: { type: 'object', properties: {}, additionalProperties: false } } };
const call = (id = 'call_1', name = 'look_room', args = '{}') => ({ id, type: 'function', function: { name, arguments: args } });
const answer = (content = 'Hello.', reason = 'stop', calls) => ({
  id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'local-test',
  choices: [{ index: 0, message: { role: 'assistant', content, ...(calls === undefined ? {} : { tool_calls: calls }) }, finish_reason: reason }],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
});
const clone = value => JSON.parse(JSON.stringify(value));
const safeError = code => error => {
  assert.equal(error.name, 'ResidentProviderError');
  assert.equal(error.code, `RESIDENT_PROVIDER_${code}`);
  assert.match(error.message, /^Resident provider|^Invalid resident provider/);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.doesNotMatch(error.message, /SECRET|chatcmpl|127\.0\.0\.1|Authorization|ECONN|look_room/);
  return true;
};
async function server(t, handler, host = '127.0.0.1') {
  const requests = [];
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, path: req.url, headers: req.headers, body: JSON.parse(raw) });
    handler(req, res, requests.at(-1), requests.length);
  });
  http.listen(0, host);
  await once(http, 'listening');
  t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  const endpoint = `http://${host === '::1' ? '[::1]' : host}:${http.address().port}/v1/chat/completions`;
  return { http, endpoint, requests, adapter: options => createResidentChatAdapter({ endpoint, model: 'local-test', ...options }) };
}
function json(res, value = answer(), status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }

test('plain chat uses an actual credential-free nonstream HTTP request and returns only canonical fields', async t => {
  const fixture = await server(t, (_req, res) => json(res));
  const adapter = fixture.adapter();
  assert.equal(Object.isFrozen(adapter), true);
  assert.deepEqual(Object.keys(adapter), ['complete']);
  assert.deepEqual(await adapter.complete({ messages: MESSAGES }), {
    text: 'Hello.', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
  });
  assert.equal(fixture.requests.length, 1);
  const sent = fixture.requests[0];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.path, '/v1/chat/completions');
  assert.equal(sent.headers.authorization, undefined);
  assert.equal(sent.headers.cookie, undefined);
  assert.equal(sent.headers['x-api-key'], undefined);
  assert.deepEqual(sent.body, { model: 'local-test', messages: MESSAGES, stream: false, max_tokens: 512 });
  await adapter.complete({ messages: MESSAGES, tools: [], maxTokens: 17 });
  assert.equal(fixture.requests[1].body.max_tokens, 17);
  assert.equal(Object.hasOwn(fixture.requests[1].body, 'tools'), false);
  assert.equal(Object.hasOwn(fixture.requests[1].body, 'tool_choice'), false);
});

test('canonical tool conversations serialize the full call IDs, argument strings and tool result roles', async t => {
  const fixture = await server(t, (_req, res, _sent, count) => json(res, count === 1 ? answer(null, 'tool_calls', [call()]) : answer('I see the room.')));
  const adapter = fixture.adapter();
  const first = await adapter.complete({ messages: MESSAGES, tools: [TOOL] });
  assert.deepEqual(first.toolCalls, [{ id: 'call_1', name: 'look_room', arguments: '{}' }]);
  assert.equal(first.text, null);
  const messages = [
    { role: 'system', content: 'You are a resident.' }, ...MESSAGES,
    { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
    { role: 'tool', toolCallId: 'call_1', content: '{"visible":[]}' },
  ];
  const snapshot = clone(messages);
  const result = await adapter.complete({ messages, tools: [TOOL] });
  assert.equal(result.text, 'I see the room.');
  assert.deepEqual(messages, snapshot);
  assert.deepEqual(fixture.requests[1].body.messages, [
    snapshot[0], snapshot[1], { role: 'assistant', content: null, tool_calls: [call()] },
    { role: 'tool', content: '{"visible":[]}', tool_call_id: 'call_1' },
  ]);
  assert.deepEqual(fixture.requests[1].body.tools, [TOOL]);
  assert.equal(fixture.requests[1].body.tool_choice, 'auto');
});

test('IPv6 loopback endpoint works without hostname resolution', async t => {
  let fixture;
  try { fixture = await server(t, (_req, res) => json(res), '::1'); }
  catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) { t.skip('IPv6 loopback unavailable'); return; }
    throw error;
  }
  assert.equal((await fixture.adapter().complete({ messages: MESSAGES })).text, 'Hello.');
});

test('literal endpoint grammar rejects credentials, DNS, alternate IP forms, paths and port tricks', () => {
  const invalid = [
    'https://127.0.0.1:1234/v1/chat/completions', 'http://localhost:1234/v1/chat/completions',
    'http://127.1:1234/v1/chat/completions', 'http://2130706433:1234/v1/chat/completions',
    'http://0x7f000001:1234/v1/chat/completions', 'http://0177.0.0.1:1234/v1/chat/completions',
    'http://127.000.0.1:1234/v1/chat/completions', 'http://127.0.0.2:1234/v1/chat/completions',
    'http://0.0.0.0:1234/v1/chat/completions', 'http://example.com:1234/v1/chat/completions',
    'http://127.0.0.1.example.com:1234/v1/chat/completions', 'http://127.0.0.1.:1234/v1/chat/completions',
    'http://[::ffff:127.0.0.1]:1234/v1/chat/completions', 'http://[0:0:0:0:0:0:0:1]:1234/v1/chat/completions',
    'http://[::1%25lo]:1234/v1/chat/completions', 'http://[::2]:1234/v1/chat/completions',
    'http://user:SECRET@127.0.0.1:1234/v1/chat/completions', 'http://@127.0.0.1:1234/v1/chat/completions',
    'http://127.0.0.1:0/v1/chat/completions', 'http://127.0.0.1:65536/v1/chat/completions',
    'http://127.0.0.1:01234/v1/chat/completions', 'http://127.0.0.1/v1/chat/completions',
    'http://127.0.0.1:1234/v1/chat/completions?key=SECRET', 'http://127.0.0.1:1234/v1/chat/completions#SECRET',
    'http://127.0.0.1:1234/V1/CHAT/COMPLETIONS', 'http://127.0.0.1:1234/v1/chat/completions/', 'http://127.0.0.1:1234/v1/../v1/chat/completions',
    'http://127.0.0.1:1234/v1/chat/%63ompletions', ' http://127.0.0.1:1234/v1/chat/completions',
    'http://127.0.0.1:1234/v1/chat/completions\n', new URL('http://127.0.0.1:1234/v1/chat/completions'),
  ];
  for (const endpoint of invalid) assert.throws(() => createResidentChatAdapter({ endpoint, model: 'local' }), safeError('CONFIG'), String(endpoint));
  assert.ok(createResidentChatAdapter({ endpoint: 'HTTP://127.0.0.1:65535/v1/chat/completions', model: 'vendor/model-v1.2:q4' }));
});

test('configuration requires explicit model and endpoint and rejects extra options, secrets and environment fallback', () => {
  const valid = { endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local' };
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'SECRET';
  try {
    for (const input of [undefined, {}, { endpoint: valid.endpoint }, { model: 'local' },
      ...['', ' a', 'a b', 'x\n', 'x'.repeat(129), 3, null].map(model => ({ ...valid, model })),
      ...[0, -1, 30_001, NaN, Infinity, '100'].map(timeoutMs => ({ ...valid, timeoutMs })),
      ...['apiKey', 'headers', 'fetch', 'env', 'baseURL', 'retry', 'maxBodyBytes', 'signal'].map(key => ({ ...valid, [key]: 'SECRET' })),
      { ...valid, [Symbol('secret')]: 'SECRET' }, Object.create(valid),
    ]) assert.throws(() => createResidentChatAdapter(input), safeError('CONFIG'));
    assert.throws(() => createResidentChatAdapter({ ...valid, get timeoutMs() { throw Error('SECRET'); } }), safeError('CONFIG'));
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});

test('request validation rejects noncanonical messages, malformed tools, bad limits and unbalanced tool history before HTTP', async t => {
  const fixture = await server(t, (_req, res) => json(res));
  const adapter = fixture.adapter();
  const badMessages = [
    [], Array(1), Array(33).fill(MESSAGES[0]), [{ role: 'developer', content: 'x' }], [{ role: 'user', content: null }],
    [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], [{ role: 'assistant', content: null }],
    [{ role: 'user', content: 'x', name: 'SECRET' }], [{ role: 'user', content: 'x'.repeat(8_193) }],
    Array(5).fill({ role: 'user', content: 'x'.repeat(8_192) }),
    [{ role: 'tool', toolCallId: 'missing', content: '{}' }],
    [{ role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'look_room', arguments: '{}' }] }],
    [{ role: 'assistant', content: null, tool_calls: [call()] }, { role: 'tool', tool_call_id: 'call_1', content: '{}' }],
    [{ role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'look_room', arguments: '{}' }] }, { role: 'user', content: 'interrupt' }],
    [{ role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'look_room', arguments: '{}' }] }, { role: 'tool', toolCallId: 'wrong', content: '{}' }],
    [{ role: 'assistant', content: null, toolCalls: [{ id: 'call_1', name: 'look_room', arguments: '{' }] }],
  ];
  const badInputs = [undefined, {}, { messages: MESSAGES, apiKey: 'SECRET' }, { messages: MESSAGES, stream: true },
    ...badMessages.map(messages => ({ messages })),
    ...[null, 0, -1, 4_097, 1.5, Infinity, '512'].map(maxTokens => ({ messages: MESSAGES, maxTokens })),
    { messages: MESSAGES, signal: {} }, { messages: MESSAGES, tools: null },
    { messages: MESSAGES, tools: Array(4).fill(TOOL) }, { messages: MESSAGES, tools: [TOOL, TOOL] },
    { messages: MESSAGES, tools: [{ name: 'look_room', parameters: { type: 'object' } }] },
    { messages: MESSAGES, tools: [{ ...TOOL, secret: 'SECRET' }] },
    { messages: MESSAGES, tools: [{ type: 'function', function: { name: 'bad name', parameters: { type: 'object' } } }] },
    { messages: MESSAGES, tools: [{ type: 'function', function: { name: 'look', parameters: { type: 'array' } } }] },
    { messages: MESSAGES, tools: [{ type: 'function', function: { name: 'look', parameters: { type: 'object', maximum: Infinity } } }] },
  ];
  for (const input of badInputs) await assert.rejects(adapter.complete(input), safeError('INPUT'));
  assert.equal(fixture.requests.length, 0);
});

test('status failures never disclose body or retry, and redirects never visit their target', async t => {
  const target = await server(t, (_req, res) => json(res));
  for (const status of [201, 400, 401, 403, 429, 500, 503]) {
    const fixture = await server(t, (_req, res) => { res.writeHead(status); res.end('SECRET provider diagnostics'); });
    await assert.rejects(fixture.adapter().complete({ messages: MESSAGES }), safeError('STATUS'));
    assert.equal(fixture.requests.length, 1);
  }
  for (const status of [301, 302, 303, 307, 308]) {
    const fixture = await server(t, (_req, res) => { res.writeHead(status, { location: target.endpoint }); res.end('SECRET'); });
    await assert.rejects(fixture.adapter().complete({ messages: MESSAGES }), safeError('REDIRECT'));
    assert.equal(fixture.requests.length, 1);
  }
  assert.equal(target.requests.length, 0);
});

test('bounded response reader enforces actual bytes and Content-Length, including chunked bodies', async t => {
  const excessive = Buffer.alloc(65_537, 32);
  const fixtures = [
    await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': excessive.length }); res.end(excessive); }),
    await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write(excessive.subarray(0, 32_768)); res.end(excessive.subarray(32_768)); }),
    await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': 99_999_999 }); res.flushHeaders(); }),
  ];
  for (const fixture of fixtures) await assert.rejects(fixture.adapter().complete({ messages: MESSAGES }), safeError('BODY_LIMIT'));
  const exact = await server(t, (_req, res) => {
    const text = JSON.stringify(answer());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(text + ' '.repeat(65_536 - Buffer.byteLength(text)));
  });
  assert.equal((await exact.adapter().complete({ messages: MESSAGES })).text, 'Hello.');
});

test('non-JSON, SSE, encoded, truncated and invalid UTF-8 responses fail safely', async t => {
  const fixtures = [
    await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: SECRET'); }),
    await server(t, (_req, res) => { res.writeHead(200); res.end(JSON.stringify(answer())); }),
    await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end('SECRET'); }),
    await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"SECRET":'); }),
    await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(Buffer.from([0xff, 0xfe])); }),
  ];
  for (const fixture of fixtures) await assert.rejects(fixture.adapter().complete({ messages: MESSAGES }), safeError('RESPONSE'));
  const interrupted = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 500 });
    res.write('{'); setImmediate(() => res.destroy());
  });
  await assert.rejects(interrupted.adapter().complete({ messages: MESSAGES }), safeError('NETWORK'));
});

test('malformed envelopes, reasoning, nonfinite numbers and incoherent finish reasons are rejected', async t => {
  const mutate = change => { const result = answer(); change(result); return result; };
  const invalid = [
    null, [], {}, { error: { message: 'SECRET' } },
    mutate(r => { r.error = { message: 'SECRET' }; }), mutate(r => { r.choices = []; }),
    mutate(r => { r.choices.push(clone(r.choices[0])); }), mutate(r => { r.choices[0].index = 1; }),
    mutate(r => { delete r.choices[0].index; }), mutate(r => { r.choices[0].message.role = 'user'; }),
    mutate(r => { r.choices[0].finish_reason = null; }), mutate(r => { r.choices[0].finish_reason = 'function_call'; }),
    mutate(r => { r.choices[0].finish_reason = 'tool_calls'; }), mutate(r => { r.choices[0].message.content = null; }),
    mutate(r => { delete r.choices[0].message.content; }), mutate(r => { r.choices[0].message.content = 42; }),
    mutate(r => { r.choices[0].message.content = [{ type: 'text', text: 'SECRET' }]; }),
    mutate(r => { r.choices[0].message.reasoning = 'SECRET'; }), mutate(r => { r.choices[0].message.reasoning_content = null; }),
    mutate(r => { r.choices[0].message.refusal = 'SECRET'; }), mutate(r => { r.choices[0].delta = { content: 'SECRET' }; }),
    mutate(r => { r.choices[0].message.tool_calls = [call()]; }), mutate(r => { r.choices[0].message.tool_calls = []; }),
    mutate(r => { r.usage.total_tokens = 14; }), mutate(r => { r.usage.prompt_tokens = -1; }),
    mutate(r => { r.usage.completion_tokens = 1.5; }), mutate(r => { delete r.usage.total_tokens; }),
    mutate(r => { r.usage.total_tokens = '15'; }), mutate(r => { r.usage.completion_tokens_details = { reasoning_tokens: 1 }; }),
    mutate(r => { r.model = { secret: 'SECRET' }; }), mutate(r => { r.extra = 'SECRET'; }),
    answer('é'.repeat(4_097)), answer('x'.repeat(8_193)),
  ];
  const fixture = await server(t, (_req, res, _sent, count) => json(res, invalid[count - 1]));
  for (const result of invalid) {
    await assert.rejects(fixture.adapter().complete({ messages: MESSAGES, tools: [TOOL] }), safeError('RESPONSE'), JSON.stringify(result));
  }
  const infinity = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer()).replace('"created":1', '"created":1e400'));
  });
  await assert.rejects(infinity.adapter().complete({ messages: MESSAGES }), safeError('RESPONSE'));
});

test('tool call count, IDs, names, argument JSON and UTF-8 byte limits are strict', async t => {
  const malformed = [
    [call(), call()], [call('bad id')], [call('one', 'unknown')], [call('one', 'look_room', '[]')],
    [call('one', 'look_room', '{')], [call('one', 'look_room', '{"n":1e400}')],
    [call('one', 'look_room', '{"value":"' + 'é'.repeat(510) + '"}')],
    [call('1'), call('2'), call('3'), call('4')], [{ ...call(), type: 'custom' }],
    [{ ...call(), secret: 'SECRET' }], [{ id: 'one', type: 'function', function: { name: 'look_room', arguments: {} } }],
    [{ id: 'one', type: 'function', function: { name: 'look_room', arguments: '{}', reasoning: 'SECRET' } }],
  ];
  const fixture = await server(t, (_req, res, _sent, count) => json(res, answer(null, 'tool_calls', malformed[count - 1])));
  for (const _calls of malformed) await assert.rejects(fixture.adapter().complete({ messages: MESSAGES, tools: [TOOL] }), safeError('RESPONSE'));
  const unexpected = await server(t, (_req, res) => json(res, answer(null, 'tool_calls', [call()])));
  await assert.rejects(unexpected.adapter().complete({ messages: MESSAGES }), safeError('RESPONSE'));
  const valid = await server(t, (_req, res) => json(res, answer('Let me look.', 'tool_calls', [call('1'), call('2'), call('3')])));
  assert.equal((await valid.adapter().complete({ messages: MESSAGES, tools: [TOOL] })).toolCalls.length, 3);
});

test('length and content_filter are preserved and absent usage is null', async t => {
  const fixtures = [answer('Partial answer', 'length'), answer(null, 'content_filter'), answer('', 'stop')];
  fixtures[0].usage = null; delete fixtures[1].usage;
  const fixture = await server(t, (_req, res, _sent, count) => json(res, fixtures[count - 1]));
  const a = fixture.adapter();
  assert.deepEqual(await a.complete({ messages: MESSAGES }), { text: 'Partial answer', toolCalls: [], finishReason: 'length', usage: null });
  assert.deepEqual(await a.complete({ messages: MESSAGES }), { text: null, toolCalls: [], finishReason: 'content_filter', usage: null });
  assert.equal((await a.complete({ messages: MESSAGES })).text, '');
});

test('pre-abort and abort during body read are distinct from bounded whole-response timeouts', async t => {
  let reached;
  const started = new Promise(resolve => { reached = resolve; });
  const fixture = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); reached();
  });
  const before = new AbortController(); before.abort(new Error('SECRET abort reason'));
  await assert.rejects(fixture.adapter().complete({ messages: MESSAGES, signal: before.signal }), safeError('ABORTED'));
  assert.equal(fixture.requests.length, 0);
  const during = new AbortController();
  const pending = fixture.adapter().complete({ messages: MESSAGES, signal: during.signal });
  const rejection = assert.rejects(pending, safeError('ABORTED'));
  await started; during.abort(new Error('SECRET abort reason')); await rejection;
  const timeout = await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); });
  await assert.rejects(timeout.adapter({ timeoutMs: 30 }).complete({ messages: MESSAGES }), safeError('TIMEOUT'));
  assert.equal(timeout.requests.length, 1);
  const noHeaders = await server(t, () => {});
  await assert.rejects(noHeaders.adapter({ timeoutMs: 30 }).complete({ messages: MESSAGES }), safeError('TIMEOUT'));
  assert.equal(noHeaders.requests.length, 1);
});

test('socket errors are sanitized and are not retried', async t => {
  const fixture = await server(t, (req) => req.socket.destroy(new Error('SECRET')));
  await assert.rejects(fixture.adapter().complete({ messages: MESSAGES }), safeError('NETWORK'));
  assert.equal(fixture.requests.length, 1);
});


test('unexpected caller signal method exceptions cannot expose raw error details', async t => {
  const fixture = await server(t, (_req, res) => json(res));
  const controller = new AbortController();
  controller.signal.addEventListener = () => { throw new Error('SECRET caller diagnostics'); };
  await assert.rejects(fixture.adapter().complete({ messages: MESSAGES, signal: controller.signal }), safeError('NETWORK'));
  assert.equal(fixture.requests.length, 0);
});


test('cleanup failures cannot hang completion or disclose caller diagnostics', async t => {
  const fixture = await server(t, (_req, res) => json(res));
  const controller = new AbortController();
  controller.signal.removeEventListener = () => { throw new Error('SECRET cleanup diagnostics'); };
  assert.equal((await fixture.adapter().complete({ messages: MESSAGES, signal: controller.signal })).text, 'Hello.');
});
