import { request } from 'node:http';

// An explicit, credential-free local transport. No environment, proxy, SDK,
// redirect, retry, or automatic tool configuration is consulted here.
const MAX_BODY_BYTES = 65_536;
const MAX_TEXT_BYTES = 8_192;
const MAX_ARGUMENT_BYTES = 1_024;
const MAX_CONTEXT_BYTES = 32_768;
const MAX_TOOLS = 3;
const providerErrors = new WeakSet();
const CODES = Object.freeze({
  CONFIG: 'Invalid resident provider configuration.',
  INPUT: 'Invalid resident provider request.',
  ABORTED: 'Resident provider request was cancelled.',
  TIMEOUT: 'Resident provider request timed out.',
  NETWORK: 'Resident provider transport failed.',
  STATUS: 'Resident provider returned an unsuccessful status.',
  REDIRECT: 'Resident provider redirects are forbidden.',
  BODY_LIMIT: 'Resident provider response exceeded its byte limit.',
  RESPONSE: 'Resident provider returned an invalid response.',
});

function failure(kind) {
  const error = new Error(CODES[kind]);
  error.name = 'ResidentProviderError';
  error.code = `RESIDENT_PROVIDER_${kind}`;
  providerErrors.add(error);
  return error;
}
function ensure(condition, kind = 'INPUT') { if (!condition) throw failure(kind); }
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function keys(value, allowed, kind = 'INPUT') {
  ensure(record(value), kind);
  for (const key of Reflect.ownKeys(value)) {
    ensure(typeof key === 'string' && allowed.includes(key), kind);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    ensure(descriptor && 'value' in descriptor && descriptor.enumerable, kind);
  }
}
function boundedText(value, limit = MAX_TEXT_BYTES) {
  return typeof value === 'string' && value.length <= limit && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= limit;
}
function denseArray(value, min, max, kind = 'INPUT') {
  ensure(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length >= min && value.length <= max, kind);
  ensure(Reflect.ownKeys(value).length === value.length + 1, kind);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    ensure(descriptor && 'value' in descriptor && descriptor.enumerable, kind);
  }
}
function identifier(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value); }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }

// JSON.parse accepts 1e400 as Infinity. Walk every value, including provider
// metadata, rather than only checking the fields retained in the result.
function finiteJSON(value, kind, depth = 0, state = { nodes: 0 }) {
  ensure(depth <= 16 && ++state.nodes <= 8_192, kind);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { ensure(Number.isFinite(value), kind); return; }
  if (Array.isArray(value)) {
    denseArray(value, 0, 2_048, kind);
    for (const item of value) finiteJSON(item, kind, depth + 1, state);
    return;
  }
  ensure(record(value), kind);
  const ownKeys = Reflect.ownKeys(value);
  ensure(ownKeys.length <= 256, kind);
  for (const key of ownKeys) {
    ensure(typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key), kind);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    ensure(descriptor && 'value' in descriptor && descriptor.enumerable, kind);
    finiteJSON(descriptor.value, kind, depth + 1, state);
  }
}
function argumentsText(value, kind) {
  ensure(boundedText(value, MAX_ARGUMENT_BYTES), kind);
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw failure(kind); }
  ensure(record(parsed), kind);
  finiteJSON(parsed, kind);
  return value;
}
function canonicalCalls(value, kind, wire = false) {
  denseArray(value, 1, MAX_TOOLS, kind);
  const ids = new Set();
  return value.map(call => {
    keys(call, wire ? ['id', 'type', 'function'] : ['id', 'name', 'arguments'], kind);
    const body = wire ? call.function : call;
    if (wire) {
      ensure(call.type === 'function', kind);
      keys(body, ['name', 'arguments'], kind);
    }
    ensure(identifier(call.id) && !ids.has(call.id) && identifier(body.name), kind);
    ids.add(call.id);
    return { id: call.id, name: body.name, arguments: argumentsText(body.arguments, kind) };
  });
}
function wireCalls(calls) {
  return calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
}

function prepareTools(tools) {
  if (tools === undefined) return undefined;
  denseArray(tools, 0, MAX_TOOLS);
  if (tools.length === 0) return undefined;
  const names = new Set();
  return tools.map(tool => {
    keys(tool, ['type', 'function']);
    ensure(tool.type === 'function');
    const fn = tool.function;
    keys(fn, ['name', 'description', 'parameters', 'strict']);
    ensure(identifier(fn.name) && !names.has(fn.name));
    names.add(fn.name);
    ensure(fn.description === undefined || boundedText(fn.description, 1_024));
    ensure(fn.strict === undefined || typeof fn.strict === 'boolean');
    ensure(record(fn.parameters) && fn.parameters.type === 'object');
    finiteJSON(fn.parameters, 'INPUT');
    ensure(Buffer.byteLength(JSON.stringify(fn.parameters), 'utf8') <= 8_192);
    const result = { name: fn.name, parameters: JSON.parse(JSON.stringify(fn.parameters)) };
    if (fn.description !== undefined) result.description = fn.description;
    if (fn.strict !== undefined) result.strict = fn.strict;
    return { type: 'function', function: result };
  });
}

function prepareMessages(messages) {
  denseArray(messages, 1, 32);
  let contextBytes = 0;
  const pending = new Set(), seen = new Set();
  const result = messages.map(message => {
    ensure(record(message));
    const role = message.role;
    ensure(['system', 'user', 'assistant', 'tool'].includes(role));
    if (role === 'tool') {
      keys(message, ['role', 'content', 'toolCallId']);
      const id = message.toolCallId;
      ensure(identifier(id) && pending.has(id) && boundedText(message.content));
      pending.delete(id);
      contextBytes += Buffer.byteLength(message.content, 'utf8');
      return { role, content: message.content, tool_call_id: id };
    }
    ensure(pending.size === 0);
    if (role !== 'assistant') {
      keys(message, ['role', 'content']);
      ensure(boundedText(message.content));
      contextBytes += Buffer.byteLength(message.content, 'utf8');
      return { role, content: message.content };
    }
    keys(message, ['role', 'content', 'toolCalls']);
    const rawCalls = message.toolCalls;
    if (rawCalls !== undefined) denseArray(rawCalls, 0, MAX_TOOLS);
    const calls = rawCalls === undefined || rawCalls.length === 0 ? [] : canonicalCalls(rawCalls, 'INPUT');
    ensure(boundedText(message.content) || (message.content === null && calls.length > 0));
    if (message.content !== null) contextBytes += Buffer.byteLength(message.content, 'utf8');
    const result = { role, content: message.content };
    if (calls.length > 0) {
      for (const call of calls) {
        ensure(!seen.has(call.id)); seen.add(call.id); pending.add(call.id);
        contextBytes += Buffer.byteLength(call.arguments, 'utf8');
      }
      result.tool_calls = wireCalls(calls);
    }
    return result;
  });
  ensure(pending.size === 0 && contextBytes <= MAX_CONTEXT_BYTES);
  return result;
}

function parseResponse(bytes, offeredTools) {
  let envelope;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw failure('RESPONSE'); }
  finiteJSON(envelope, 'RESPONSE');
  keys(envelope, ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier'], 'RESPONSE');
  for (const key of ['id', 'object', 'model']) ensure(envelope[key] === undefined || boundedText(envelope[key], 256), 'RESPONSE');
  for (const key of ['system_fingerprint', 'service_tier']) ensure(envelope[key] === undefined || envelope[key] === null || boundedText(envelope[key], 256), 'RESPONSE');
  ensure(envelope.created === undefined || integer(envelope.created, 0, Number.MAX_SAFE_INTEGER), 'RESPONSE');
  ensure(Array.isArray(envelope.choices) && envelope.choices.length === 1, 'RESPONSE');
  const choice = envelope.choices[0];
  keys(choice, ['index', 'message', 'finish_reason', 'logprobs'], 'RESPONSE');
  ensure(choice.index === 0, 'RESPONSE');
  ensure(choice.logprobs === undefined || choice.logprobs === null, 'RESPONSE');
  const reason = choice.finish_reason;
  ensure(['stop', 'tool_calls', 'length', 'content_filter'].includes(reason), 'RESPONSE');
  const message = choice.message;
  keys(message, ['role', 'content', 'tool_calls', 'refusal'], 'RESPONSE');
  ensure(message.role === 'assistant', 'RESPONSE');
  ensure(message.refusal === undefined || message.refusal === null, 'RESPONSE');
  ensure(message.content === null || boundedText(message.content), 'RESPONSE');
  const calls = message.tool_calls === undefined ? [] : canonicalCalls(message.tool_calls, 'RESPONSE', true);
  if (reason === 'tool_calls') {
    ensure(calls.length > 0, 'RESPONSE');
    const names = new Set((offeredTools ?? []).map(tool => tool.function.name));
    ensure(calls.every(call => names.has(call.name)), 'RESPONSE');
  } else {
    ensure(calls.length === 0, 'RESPONSE');
    if (reason !== 'content_filter') ensure(typeof message.content === 'string', 'RESPONSE');
  }
  let usage = null;
  if (envelope.usage !== undefined && envelope.usage !== null) {
    keys(envelope.usage, ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details'], 'RESPONSE');
    const u = envelope.usage;
    ensure([u.prompt_tokens, u.completion_tokens, u.total_tokens].every(value => integer(value, 0, Number.MAX_SAFE_INTEGER)), 'RESPONSE');
    ensure(Number.isSafeInteger(u.prompt_tokens + u.completion_tokens) && u.total_tokens === u.prompt_tokens + u.completion_tokens, 'RESPONSE');
    for (const field of ['prompt_tokens_details', 'completion_tokens_details']) {
      if (u[field] !== undefined && u[field] !== null) {
        ensure(record(u[field]), 'RESPONSE');
        // Detailed reasoning/token accounting is deliberately not admitted.
        const allowed = field === 'prompt_tokens_details' ? ['cached_tokens', 'audio_tokens'] : ['audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'];
        keys(u[field], allowed, 'RESPONSE');
        for (const value of Object.values(u[field])) ensure(integer(value, 0, u.total_tokens), 'RESPONSE');
      }
    }
    usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens };
  }
  return { text: message.content, toolCalls: calls, finishReason: reason, usage };
}

function transport({ hostname, port, timeoutMs }, body, signal, offeredTools) {
  return new Promise((resolve, reject) => {
    let settled = false, response, timer, req;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { signal?.removeEventListener('abort', onAbort); } catch { /* Never expose caller errors during cleanup. */ }
      if (error) { response?.destroy(); req?.destroy(); reject(error); }
      else resolve(value);
    };
    const onAbort = () => finish(failure('ABORTED'));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(failure('TIMEOUT')), timeoutMs);
    try {
      req = request({
        protocol: 'http:', hostname, port, path: '/v1/chat/completions',
        method: 'POST', agent: false, maxHeaderSize: 8_192,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8') },
      }, incoming => {
        response = incoming;
        const status = incoming.statusCode ?? 0;
        if (status >= 300 && status < 400) { finish(failure('REDIRECT')); return; }
        if (status !== 200) { finish(failure('STATUS')); return; }
        if (!/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(incoming.headers['content-type'] ?? '') ||
            (incoming.headers['content-encoding'] !== undefined && incoming.headers['content-encoding'] !== 'identity')) {
          finish(failure('RESPONSE')); return;
        }
        const length = incoming.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) { finish(failure('BODY_LIMIT')); return; }
        const chunks = [];
        let size = 0;
        incoming.on('data', chunk => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_BODY_BYTES) { finish(failure('BODY_LIMIT')); return; }
          chunks.push(chunk);
        });
        incoming.on('error', () => finish(failure('NETWORK')));
        incoming.on('aborted', () => finish(failure('NETWORK')));
        incoming.on('end', () => {
          if (settled) return;
          try { finish(null, parseResponse(Buffer.concat(chunks, size), offeredTools)); }
          catch { finish(failure('RESPONSE')); }
        });
      });
      req.on('error', () => finish(failure('NETWORK')));
      req.end(body);
    } catch { finish(failure('NETWORK')); }
  });
}

/**
 * createResidentChatAdapter({ endpoint, model, timeoutMs = 5000 })
 * complete({ messages, tools?, signal?, maxTokens = 512 })
 *
 * Canonical messages use toolCalls [{ id, name, arguments }] and toolCallId;
 * OpenAI wire aliases are deliberately rejected on input.
 * Tools are OpenAI-shaped { type: 'function', function: { name, parameters,
 * description?, strict? } } descriptors.
 * No tools means no tools or tool_choice key is sent. Limits are fixed: 32
 * messages, 32 KiB context, 3 tools/calls, 64 KiB wire body, 8 KiB text,
 * 1 KiB argument JSON. Only literal loopback addresses are accepted.
 */
export function createResidentChatAdapter(options) {
  let config, model;
  try {
    keys(options, ['endpoint', 'model', 'timeoutMs'], 'CONFIG');
    const match = typeof options.endpoint === 'string' && options.endpoint.match(/^[Hh][Tt][Tt][Pp]:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/v1\/chat\/completions$/);
    ensure(match && match[0] === options.endpoint && Number(match[2]) <= 65_535, 'CONFIG');
    model = options.model;
    ensure(typeof model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model), 'CONFIG');
    const timeoutMs = options.timeoutMs === undefined ? 5_000 : options.timeoutMs;
    ensure(integer(timeoutMs, 1, 30_000), 'CONFIG');
    config = { hostname: match[1] === '[::1]' ? '::1' : '127.0.0.1', port: Number(match[2]), timeoutMs };
  } catch { throw failure('CONFIG'); }
  return Object.freeze({
    async complete(input) {
      let body, signal, tools;
      try {
        keys(input, ['messages', 'tools', 'signal', 'maxTokens']);
        signal = input.signal;
        ensure(signal === undefined || signal instanceof AbortSignal);
        const maxTokens = input.maxTokens === undefined ? 512 : input.maxTokens;
        ensure(integer(maxTokens, 1, 4_096));
        tools = prepareTools(input.tools);
        const payload = { model, messages: prepareMessages(input.messages), stream: false, max_tokens: maxTokens };
        if (tools) { payload.tools = tools; payload.tool_choice = 'auto'; }
        body = JSON.stringify(payload);
        ensure(Buffer.byteLength(body, 'utf8') <= MAX_BODY_BYTES);
      } catch { throw failure('INPUT'); }
      try { return await transport(config, body, signal, tools); }
      catch (error) { throw providerErrors.has(error) ? error : failure('NETWORK'); }
    },
  });
}
