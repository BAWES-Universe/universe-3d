import test from 'node:test';
import assert from 'node:assert/strict';
import { readSiteAdmissionConfig, validateSiteAdmissionConfig } from '../server/site-admission-config.mjs';

test('site admission is disabled by default and enabled only by explicit invite-only mode', () => {
  const defaults = readSiteAdmissionConfig({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.inviteTtlMs, 86400000);
  assert.equal(defaults.maxActiveInvites, 25);
  assert.equal(defaults.maxAccounts, 50);
  assert.equal(defaults.maxInviteRecords, 1000);
  assert.equal(Object.isFrozen(defaults), true);
  for (const mode of ['disabled', 'local-open']) assert.equal(readSiteAdmissionConfig({ UNIVERSE_REGISTRATION_MODE: mode }).enabled, false);
  assert.equal(readSiteAdmissionConfig({ UNIVERSE_REGISTRATION_MODE: 'invite-only' }).enabled, true);
  assert.throws(() => readSiteAdmissionConfig({ UNIVERSE_REGISTRATION_MODE: 'open' }));
  assert.throws(() => readSiteAdmissionConfig({ UNIVERSE_SITE_ADMISSION_ENABLED: 'true' }));
});

test('configuration rejects coercions, unknown settings and unbounded limits', () => {
  for (const input of [null, [], true, { enabled: 'true' }, { typo: true }, { inviteTtlMs: 0 }, { inviteTtlMs: 7 * 86400000 + 1 }, { maxActiveInvites: 0 }, { maxAccounts: Infinity }, { maxConcurrentHashes: 5 }, { maxInviteRecords: 100001 }, { checkPerMinute: 1.5 }]) assert.throws(() => validateSiteAdmissionConfig(input));
  for (const value of ['0', '-1', '1.1', ' 2 ', '2e2', 'Infinity', 'NaN', '01', 2]) assert.throws(() => readSiteAdmissionConfig({ UNIVERSE_SITE_MAX_ACCOUNTS: value }));
  assert.equal(readSiteAdmissionConfig({ UNIVERSE_SITE_MAX_ACCOUNTS: '25', UNIVERSE_SITE_INVITE_TTL_MS: '3600000' }).maxAccounts, 25);
});
