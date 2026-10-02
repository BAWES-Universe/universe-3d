/** Pure validation and geometry. No production configuration is selected here. */
export function invariant(condition, code) {
  if (!condition) { const error = new Error(code); error.code = code; throw error; }
}
export const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function id(value, name = 'id') {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value), `INVALID_${name}`);
  return value;
}
export function finite(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  invariant(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, `INVALID_${name}`);
  return value;
}
export function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  finite(value, name, min, max); invariant(Number.isSafeInteger(value), `INVALID_${name}`); return value;
}
export function boolean(value, name) { invariant(typeof value === 'boolean', `INVALID_${name}`); return value; }
export function validateConfig(input) {
  invariant(input && typeof input === 'object', 'CONFIG_REQUIRED');
  const c = { ...input };
  for (const name of ['sourceUnitsPerWorldUnit', 'minimumDistanceSource', 'groupRadiusSource', 'coordinateLimitWorld', 'memberTtlMs']) finite(c[name], name, Number.EPSILON);
  for (const name of ['membershipCeiling', 'maxRooms', 'maxMembersPerRoom', 'maxAccounts', 'maxMemberships']) integer(c[name], name, name === 'membershipCeiling' ? 2 : 1, 100000);
  integer(c.p2pThreshold, 'p2pThreshold', 1, 100000);
  integer(c.downgradeDelayMs, 'downgradeDelayMs');
  invariant(c.membershipCeiling <= c.maxMembersPerRoom, 'CEILING_EXCEEDS_ROOM_BOUND');
  invariant(['source-threshold', 'force-sfu-target'].includes(c.meetingPolicy), 'INVALID_meetingPolicy');
  // Bound derived arithmetic too: no finite input may create infinite geometry.
  invariant(c.coordinateLimitWorld * c.sourceUnitsPerWorldUnit <= Number.MAX_SAFE_INTEGER / 4, 'UNSAFE_COORDINATE_SCALE');
  return Object.freeze(c);
}
export const PROXIMITY_EXCLUDED_STATUSES = Object.freeze([
  'DENY_PROXIMITY_MEETING', 'SILENT', 'JITSI', 'BBB', 'SPEAKER',
  'DO_NOT_DISTURB', 'BACK_IN_A_MOMENT', 'LIVEKIT', 'LISTENER',
]);
export const STATUSES = Object.freeze(['ONLINE', 'AWAY', ...PROXIMITY_EXCLUDED_STATUSES]);
export const proximityEligible = member => member.context.kind === 'proximity' && !PROXIMITY_EXCLUDED_STATUSES.includes(member.status);
export const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export function toSourcePosition(position, config) {
  return {
    x: finite(position.x, 'x', -config.coordinateLimitWorld, config.coordinateLimitWorld) * config.sourceUnitsPerWorldUnit,
    z: finite(position.z, 'z', -config.coordinateLimitWorld, config.coordinateLimitWorld) * config.sourceUnitsPerWorldUnit,
  };
}
/** Source x,y -> candidate x,z, with the same factor on both planar axes. */
export function barycenter(members) {
  invariant(members.length > 0, 'EMPTY_BARYCENTER');
  const ids = new Set(members.map(m => m.accountId));
  let heads = members.filter(m => !m.followLeaderId || !ids.has(m.followLeaderId));
  if (heads.length === 0) heads = members;
  // Divide before summing to retain a finite mean under validated coordinate bounds.
  return { x: heads.reduce((sum, m) => sum + m.position.x / heads.length, 0), z: heads.reduce((sum, m) => sum + m.position.z / heads.length, 0) };
}
