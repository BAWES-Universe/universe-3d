import test from 'node:test';
import assert from 'node:assert/strict';
import {readProximityRuntimeConfig} from '../server/proximity-runtime-config.mjs';
import {proximityFixture} from './fixtures/proximity-config.mjs';

// Every number below comes from a synthetic fixture, not deployed/source policy.
const off = () => ({membership:{enabled:false}, text:{enabled:false}});
const on = () => ({membership:{...proximityFixture}, text:{enabled:true}});
const read = config => readProximityRuntimeConfig({UNIVERSE_PROXIMITY_CONFIG:JSON.stringify(config)});
const invalid = callback => assert.throws(callback, /^Error: Invalid UNIVERSE_PROXIMITY_CONFIG:/);

test('absent variable and explicit off omit both factory options', () => {
  assert.deepEqual(readProximityRuntimeConfig({}), {});
  assert.deepEqual(read(off()), {});
  assert(Object.isFrozen(read(off())));
  const env = Object.create({UNIVERSE_PROXIMITY_CONFIG:JSON.stringify(on())});
  assert.deepEqual(readProximityRuntimeConfig(env), {});
});

test('reader requires a provided environment and never reads ambient process configuration', () => {
  for (const value of [undefined, null, false, [], '']) invalid(() => readProximityRuntimeConfig(value));
  const saved = process.env.UNIVERSE_PROXIMITY_CONFIG;
  try {
    process.env.UNIVERSE_PROXIMITY_CONFIG = JSON.stringify(on());
    assert.deepEqual(readProximityRuntimeConfig({}), {});
    assert.deepEqual(read(off()), {});
  } finally {
    if (saved === undefined) delete process.env.UNIVERSE_PROXIMITY_CONFIG;
    else process.env.UNIVERSE_PROXIMITY_CONFIG = saved;
  }
});

test('explicit complete membership and text are validated, immutable and uncoerced', () => {
  const config = on(), options = read(config);
  assert.deepEqual(options.proximityMembershipConfig, {...proximityFixture, meetingPolicy:'source-threshold'});
  assert.deepEqual(options.proximityTextConfig, {enabled:true});
  assert(Object.isFrozen(options));
  assert(Object.isFrozen(options.proximityMembershipConfig));
  assert(Object.isFrozen(options.proximityTextConfig));
  assert.deepEqual(config, on());
});

test('membership can be explicitly enabled while text stays off', () => {
  const options = read({...on(), text:{enabled:false}});
  assert.equal(options.proximityMembershipConfig.enabled, true);
  assert.equal(Object.hasOwn(options, 'proximityTextConfig'), false);
  invalid(() => read({...off(), text:{enabled:true}}));
});

test('every policy field is required when membership is enabled', () => {
  for (const key of Object.keys(proximityFixture)) {
    const config = on(); delete config.membership[key];
    invalid(() => read(config));
  }
});

test('present empty, non-string, malformed and scalar input never falls back to off', () => {
  for (const value of [undefined, null, false, 0, {}, [], '', '  ', 'null', 'true', 'false', '0', '[]', '"off"', '{', '{"membership":}', '\uFEFF{}']) {
    invalid(() => readProximityRuntimeConfig({UNIVERSE_PROXIMITY_CONFIG:value}));
  }
});

test('root and feature schemas reject partial or unknown fields, including disabled leftovers', () => {
  for (const config of [{}, {membership:{enabled:false}}, {text:{enabled:false}}, {...off(), extra:1},
    {...off(), membership:null}, {...off(), text:[]}, {...off(), membership:{}}, {...off(), text:{}},
    {...off(), membership:{enabled:false, membershipCeiling:8}}, {...off(), text:{enabled:false, history:200}},
    {...on(), membership:{...proximityFixture, meetingPolicy:'source-threshold'}},
    {...on(), text:{enabled:true, history:200}}, {...on(), membership:{...proximityFixture, unknown:1}}]) invalid(() => read(config));
});

test('boolean flags require booleans and all numeric policy values require numbers', () => {
  for (const field of ['membership', 'text']) for (const value of ['true', 'false', 1, 0, null, [], {}]) {
    const config = on(); config[field].enabled = value; invalid(() => read(config));
  }
  for (const [field, value] of Object.entries(proximityFixture)) {
    if (field === 'enabled') continue;
    for (const bad of [String(value), null, true]) {
      const config = on(); config.membership[field] = bad; invalid(() => read(config));
    }
  }
});

test('existing authority bounds and consistency rules remain authoritative', () => {
  for (const overrides of [
    {membershipCeiling:1}, {membershipCeiling:101}, {p2pThreshold:0}, {p2pThreshold:1.5},
    {downgradeDelayMs:-1}, {downgradeDelayMs:0.5}, {minimumDistanceSource:0}, {groupRadiusSource:-1},
    {sourceUnitsPerWorldUnit:0}, {coordinateLimitWorld:0}, {memberTtlMs:60001},
    {maxRooms:65}, {maxMembersPerRoom:257}, {maxAccounts:4097}, {maxMemberships:8193},
    {maxSessionsPerMember:17}, {coordinateLimitWorld:Number.MAX_SAFE_INTEGER},
  ]) invalid(() => read({...on(), membership:{...proximityFixture, ...overrides}}));
  invalid(() => readProximityRuntimeConfig({UNIVERSE_PROXIMITY_CONFIG:JSON.stringify(on()).replace('"groupRadiusSource":48', '"groupRadiusSource":1e999')}));
});

test('duplicate JSON names cannot override an earlier off flag or policy value', () => {
  for (const text of [
    '{"membership":{"enabled":false,"enabled":true},"text":{"enabled":false}}',
    '{"membership":{"enabled":false},"text":{"enabled":false},"text":{"enabled":true}}',
    '{"membership":{"enabled":false},"text":{"enabled":false,"enab\\u006ced":false}}',
    JSON.stringify(on()).replace('"membershipCeiling":8', '"membershipCeiling":2,"membershipCeiling":8'),
  ]) invalid(() => readProximityRuntimeConfig({UNIVERSE_PROXIMITY_CONFIG:text}));
  assert.deepEqual(readProximityRuntimeConfig({UNIVERSE_PROXIMITY_CONFIG:' { "membership" : { "enabled" : false }, "text" : { "enabled" : false } } '}), {});
});

test('errors disclose fixed schema/rule names without submitted values or unknown field names', () => {
  const marker = 'SYNTHETIC_NOT_A_CREDENTIAL';
  for (const text of [`{"${marker}":`, JSON.stringify({...off(), [marker]:marker}),
    JSON.stringify({...on(), membership:{...proximityFixture, p2pThreshold:marker}}),
    JSON.stringify({...on(), text:{enabled:true, [marker]:marker}}),
    `{"membership":{"enabled":false},"text":{"enabled":false},"${marker}":"${marker}","${marker}":true}`]) {
    assert.throws(() => readProximityRuntimeConfig({UNIVERSE_PROXIMITY_CONFIG:text, SYNTHETIC_UNUSED_CREDENTIAL:marker}), error => {
      assert.match(error.message, /^Invalid UNIVERSE_PROXIMITY_CONFIG:/);
      assert.equal(error.stack.includes(marker), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
