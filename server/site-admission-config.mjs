const DEFAULTS = Object.freeze({
  enabled: false,
  inviteTtlMs: 24 * 60 * 60 * 1000,
  maxActiveInvites: 25,
  maxAccounts: 50,
  maxInviteRecords: 1000,
  maxConcurrentHashes: 2,
  checkPerMinute: 30,
  redeemPerMinute: 10,
  ownerPerMinute: 30,
});
const LIMITS = Object.freeze({
  inviteTtlMs: [60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000],
  maxActiveInvites: [1, 1000], maxAccounts: [1, 10000], maxInviteRecords: [1, 100000],
  maxConcurrentHashes: [1, 4], checkPerMinute: [1, 120],
  redeemPerMinute: [1, 30], ownerPerMinute: [1, 120],
});
const ENV = Object.freeze({
  inviteTtlMs: 'UNIVERSE_SITE_INVITE_TTL_MS',
  maxActiveInvites: 'UNIVERSE_SITE_MAX_ACTIVE_INVITES',
  maxAccounts: 'UNIVERSE_SITE_MAX_ACCOUNTS',
  maxInviteRecords: 'UNIVERSE_SITE_MAX_INVITE_RECORDS',
  maxConcurrentHashes: 'UNIVERSE_SITE_MAX_CONCURRENT_HASHES',
  checkPerMinute: 'UNIVERSE_SITE_CHECKS_PER_MINUTE',
  redeemPerMinute: 'UNIVERSE_SITE_REDEMPTIONS_PER_MINUTE',
  ownerPerMinute: 'UNIVERSE_SITE_OWNER_REQUESTS_PER_MINUTE',
});
const fail = message => { throw new Error(`Invalid Universe site admission configuration: ${message}`); };

export function validateSiteAdmissionConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('expected an object');
  if (Object.keys(input).some(key => !Object.hasOwn(DEFAULTS, key))) fail('unknown setting');
  const result = { ...DEFAULTS, ...input };
  if (typeof result.enabled !== 'boolean') fail('enabled must be a boolean');
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > max) fail(`${key} must be an integer from ${min} to ${max}`);
  }
  return Object.freeze(result);
}

/** Only process entry points should call this with process.env. Factories use {}. */
export function readSiteAdmissionConfig(env = process.env) {
  const config = {};
  if (env.UNIVERSE_REGISTRATION_MODE !== undefined && !['disabled', 'local-open', 'invite-only'].includes(env.UNIVERSE_REGISTRATION_MODE)) fail('UNIVERSE_REGISTRATION_MODE is not recognized');
  config.enabled = env.UNIVERSE_REGISTRATION_MODE === 'invite-only';
  if (env.UNIVERSE_SITE_ADMISSION_ENABLED !== undefined) fail('use UNIVERSE_REGISTRATION_MODE=invite-only to enable signup');
  for (const [key, variable] of Object.entries(ENV)) {
    if (env[variable] === undefined) continue;
    if (typeof env[variable] !== 'string' || !/^[1-9][0-9]*$/.test(env[variable])) fail(`${variable} must be an integer`);
    config[key] = Number(env[variable]);
  }
  return validateSiteAdmissionConfig(config);
}
