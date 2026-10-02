// Strict public-result boundary for the existing resident-protocol runner.
// No request, prompt, raw provider envelope, or authorization snapshot is stored.
export class TurnJournalError extends Error {
  constructor(code) { super(code); this.name = 'TurnJournalError'; this.code = code; }
}
export function fail(code) { throw new TurnJournalError(code); }
export function exact(value, required, optional = [], code = 'TURN_JOURNAL_INVALID_INPUT') {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key) || !('value' in properties[key]) || !properties[key].enumerable)
    || required.some(key => !Object.hasOwn(properties, key))) fail(code);
  return value;
}
export function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail('TURN_JOURNAL_INVALID_ID');
  return value;
}
export function fingerprint(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('TURN_JOURNAL_INVALID_FINGERPRINT');
  return value;
}
export function integer(value, min, max, code = 'TURN_JOURNAL_INVALID_INPUT') {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}
function code(value) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value)) fail('TURN_JOURNAL_INVALID_RECEIPT');
  return value;
}
const states = new Set(['completed', 'truncated', 'filtered', 'limited', 'uncertain', 'timeout', 'cancelled', 'revoked', 'error']);
const names = new Set(['pause', 'resume', 'return', 'unrecognized']);

export function publicReceipt(input, {maxReceiptBytes, protectedText}) {
  const invalid = 'TURN_JOURNAL_INVALID_RECEIPT';
  exact(input, ['status', 'text', 'textTrust', 'toolResults', 'usage'], ['code'], invalid);
  if (!states.has(input.status) || input.textTrust !== 'untrusted-provider-output'
      || typeof input.text !== 'string' || input.text.length > 8192 || /\u0000/.test(input.text)
      || (input.status !== 'completed' && input.text !== '')) fail(invalid);
  // This duplicates the runner's lexical barrier, not a semantic privacy proof.
  if (/[<>]|(?:^|\n)\s*(?:system|developer|tool|analysis)\s*:|\b(?:tool_calls|reasoning_content|chain.of.thought)\b/i.test(input.text)) fail('TURN_JOURNAL_UNSAFE_RECEIPT');
  if (!Array.isArray(input.toolResults) || input.toolResults.length > 3) fail(invalid);
  // Reject sparse arrays, getters and custom properties before reading entries.
  const descriptors = Object.getOwnPropertyDescriptors(input.toolResults);
  if (Reflect.ownKeys(input.toolResults).length !== input.toolResults.length + 1
      || Array.from({length:input.toolResults.length}, (_, index) => descriptors[index]).some(d => !d || !('value' in d) || !d.enumerable)) fail(invalid);
  const callIds = new Set(), operationIds = new Set();
  const toolResults = input.toolResults.map(item => {
    exact(item, ['callId', 'name', 'operationId', 'status'], ['duplicate', 'code'], invalid);
    id(item.callId);
    if (!names.has(item.name) || typeof item.operationId !== 'string' || !/^botai-[0-9a-f]{48}$/.test(item.operationId)
        || callIds.has(item.callId) || operationIds.has(item.operationId)) fail(invalid);
    callIds.add(item.callId); operationIds.add(item.operationId);
    if (item.status === 'accepted') {
      if (item.name === 'unrecognized' || typeof item.duplicate !== 'boolean' || Object.hasOwn(item, 'code')) fail(invalid);
    } else if (item.status === 'rejected') {
      if (!['TOOL_NOT_ALLOWED', 'INVALID_TOOL_ARGUMENTS'].includes(item.code) || Object.hasOwn(item, 'duplicate')) fail(invalid);
    } else if (item.status === 'unknown') {
      if (item.code !== 'MOVEMENT_OUTCOME_UNKNOWN' || Object.hasOwn(item, 'duplicate')) fail(invalid);
    } else fail(invalid);
    return {callId:item.callId, name:item.name, operationId:item.operationId, status:item.status,
      ...(Object.hasOwn(item, 'duplicate') ? {duplicate:item.duplicate} : {}),
      ...(Object.hasOwn(item, 'code') ? {code:code(item.code)} : {})};
  });
  exact(input.usage, ['calls', 'reportedCalls', 'promptTokens', 'completionTokens', 'totalTokens'], [], invalid);
  const {calls, reportedCalls, promptTokens, completionTokens, totalTokens} = input.usage;
  integer(calls, 0, 3, invalid); integer(reportedCalls, 0, calls, invalid);
  const counts = [promptTokens, completionTokens, totalTokens];
  if (reportedCalls !== calls) {
    if (counts.some(value => value !== null)) fail(invalid);
  } else {
    counts.forEach(value => integer(value, 0, 30000000, invalid));
    if (totalTokens !== promptTokens + completionTokens) fail(invalid);
  }
  const result = {status:input.status, text:input.text, textTrust:input.textTrust, toolResults,
    usage:{calls, reportedCalls, promptTokens, completionTokens, totalTokens},
    ...(Object.hasOwn(input, 'code') ? {code:code(input.code)} : {})};
  // Scan all receipt strings, including model-controlled call IDs, before persistence.
  const strings = [result.status, result.text, result.textTrust, result.code ?? '',
    ...toolResults.flatMap(item => Object.values(item).filter(value => typeof value === 'string'))];
  if (protectedText.some(secret => strings.some(value => value.toLowerCase().includes(secret)))) fail('TURN_JOURNAL_UNSAFE_RECEIPT');
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > maxReceiptBytes) fail('TURN_JOURNAL_RECEIPT_LIMIT');
  return {result, json};
}
