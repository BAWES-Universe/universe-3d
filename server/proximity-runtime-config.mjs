import {validateProximityMembershipConfig} from './proximity-authority.mjs';
import {validateProximityTextConfig} from './proximity-text.mjs';

const ENV_KEY = 'UNIVERSE_PROXIMITY_CONFIG';
const fail = message => { throw new Error(`Invalid ${ENV_KEY}: ${message}`); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function parse(text) {
  if (typeof text !== 'string' || !text.trim()) fail('must contain a JSON object; remove the variable to leave both features off');
  let value;
  // JSON.parse errors may contain the operator's input. Never surface them.
  try { value = JSON.parse(text); } catch { fail('must contain valid JSON'); }
  // JSON.parse otherwise silently accepts duplicate names with last-value wins.
  const objects = [];
  for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/g)) {
    if (token[0] === '{') objects.push(new Set());
    else if (token[0] === '[') objects.push(null);
    else if (token[0] === '}' || token[0] === ']') objects.pop();
    else if (/^\s*:/.test(text.slice(token.index + token[0].length))) {
      const key = JSON.parse(token[0]), keys = objects.at(-1);
      if (keys.has(key)) fail('duplicate JSON field names are forbidden');
      keys.add(key);
    }
  }
  return value;
}

function enabled(config, name) {
  if (!record(config) || !Object.hasOwn(config, 'enabled') || typeof config.enabled !== 'boolean') fail(`${name}.enabled must be an explicit JSON boolean`);
  if (!config.enabled && Object.keys(config).length !== 1) fail(`disabled ${name} must contain only enabled:false`);
  return config.enabled;
}

/** Pure environment reader. Only the process entry supplies process.env.
 * Off maps to omitted factory options; enabled:false is not a factory config.
 */
export function readProximityRuntimeConfig(env) {
  if (!record(env)) fail('an explicit environment object is required');
  if (!Object.hasOwn(env, ENV_KEY)) return Object.freeze({});
  const config = parse(env[ENV_KEY]);
  if (!record(config) || Object.keys(config).length !== 2 || !Object.hasOwn(config, 'membership') || !Object.hasOwn(config, 'text')) fail('the object must contain exactly membership and text');
  const membershipEnabled = enabled(config.membership, 'membership');
  const textEnabled = enabled(config.text, 'text');
  if (textEnabled && !membershipEnabled) fail('text requires enabled membership');
  const options = {};
  if (membershipEnabled) {
    try { options.proximityMembershipConfig = validateProximityMembershipConfig(config.membership); }
    catch (error) {
      // Authority codes contain fixed field/rule names, never submitted values.
      fail(`membership policy rejected (${error.code})`);
    }
  }
  if (textEnabled) {
    try { options.proximityTextConfig = validateProximityTextConfig(config.text, options.proximityMembershipConfig); }
    catch { fail('enabled text must contain only enabled:true'); }
  }
  return Object.freeze(options);
}
