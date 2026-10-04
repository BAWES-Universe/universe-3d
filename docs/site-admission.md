# Invite-only site admission

This is an optional account-creation boundary, separate from the existing world and room invitation systems. Issuing or redeeming a site invite does not grant any universe, world, room, membership, administrator role, or ownership. Signup inserts a new ordinary user and account directly; it never calls `Store.createUser`, adopts a guest, or inherits a signed-in identity's permissions.

This code does not enable signup on an existing deployment. The reusable server factory defaults remain local/closed for this feature, and an operator must explicitly select `UNIVERSE_REGISTRATION_MODE=invite-only` in an appropriate future rollout. Public mode retains its existing offline-bootstrap and fully owned seed checks. Its legacy guest creation and `/api/account` registration remain closed.

## Authority and identity

Only the account identified by the existing `metadata` key `operator-bootstrap-v1` may create, list, or revoke site invitations. That account must still exist. World, room, and universe roles do not establish site authority. Every management request resolves its live HTTP session again after body reading; an expired or invalidated session cannot complete a delayed mutation.

Signup and receipt retries require no current valid session. An authenticated guest or account receives `409 SIGNUP_SIGN_OUT_REQUIRED`; signup never signs out, upgrades, replaces, or authenticates that identity. The frontend offers an explicit choice to keep the current identity or sign out. Successful redemption returns `loginRequired: true`, and the person uses ordinary login afterward. Receipt replay cannot create or rotate a session.

The global Host/Origin request gate runs before these routes, including check and redeem. Public requests therefore retain exact allowed Host, allowed Origin, HTTPS configuration, and Secure-cookie rules. No forwarded header becomes an admission identity.

## Configuration

`readSiteAdmissionConfig(env)` parses operator environment values. `validateSiteAdmissionConfig(config)` validates explicit factory values and rejects unknown keys, coercions, non-integer limits, and unbounded values. The factory uses an explicit environment object and does not inherit ambient `process.env`. Its `enabled` value must agree with `runtimeConfig.registrationMode === 'invite-only'`.

| Field | Environment setting | Default | Allowed range |
| --- | --- | --- | --- |
| `enabled` | `UNIVERSE_REGISTRATION_MODE=invite-only` | `false` | boolean in explicit config |
| `inviteTtlMs` | `UNIVERSE_SITE_INVITE_TTL_MS` | 86,400,000 (24h) | 1h–7d |
| `maxActiveInvites` | `UNIVERSE_SITE_MAX_ACTIVE_INVITES` | 25 | 1–1,000 |
| `maxAccounts` | `UNIVERSE_SITE_MAX_ACCOUNTS` | 50 | 1–10,000 |
| `maxInviteRecords` | `UNIVERSE_SITE_MAX_INVITE_RECORDS` | 1,000 | 1–100,000 |
| `maxConcurrentHashes` | `UNIVERSE_SITE_MAX_CONCURRENT_HASHES` | 2 | 1–4 |
| `checkPerMinute` | `UNIVERSE_SITE_CHECKS_PER_MINUTE` | 30 | 1–120 |
| `redeemPerMinute` | `UNIVERSE_SITE_REDEMPTIONS_PER_MINUTE` | 10 | 1–30 |
| `ownerPerMinute` | `UNIVERSE_SITE_OWNER_REQUESTS_PER_MINUTE` | 30 | 1–120 |

Account quota includes all existing accounts, including the bootstrapped owner and offline-provisioned accounts. Active invite quota counts unused, unrevoked invites with a future expiry. Expired/used/revoked rows remain durable and count toward the separate retained-history cap.

The public `siteAdmission` policy contains only `enabled`, `canManage`, `inviteTtlMs`, `maxActiveInvites`, and `maxAccounts`. `canManage` comes from a live optional session and the current bootstrap authority; no owner ID or invitation data is included. The policy is available through `/api/access` and session state.

## HTTP contract

Responses use the application's no-store JSON sender. Failures have the existing `{error, code, message}` envelope. All mutation bodies require `application/json`, at most 8 KiB, and completion within 10 seconds. Unknown JSON fields are rejected. Query-string bearer tokens are never accepted. Only the owner listing accepts query parameters, restricted to pagination.

A `clientOperationId` is a client-generated random 32-byte value encoded as canonical base64url (43 characters). Reuse the exact same operation and body when explicitly retrying an uncertain result. UUIDs and short counters are not accepted. Operation values are persisted only as SHA-256 hashes.

### GET `/api/site-invites`

Requires the live site owner. Optional `limit` is an integer from 1 to 100 (default 50); `cursor` must be the previous response's opaque `nextCursor`. Duplicate or unknown query parameters are rejected.

Returns `{invites, activeInvites, accountCount, maxActiveInvites, maxAccounts, hasMore, nextCursor}`. Each safe invite contains only `id`, `label`, `createdAt`, `expiresAt`, `status`, `revokedAt`, and `redeemedAt`. Status is `active`, `expired`, `redeemed`, `revoked`, or `unavailable` (issuer is no longer the bootstrap authority). No bearer, operation secret, token hash, password material, or redeemed account identity is returned. Cursor ordering is descending creation time and ID; newly minted records appear after refreshing from page one.

### POST `/api/site-invites`

Requires the site owner. Body: `{clientOperationId, label?, expiresInMs?}`. Label is at most 80 characters; expiry is an integer from 1h to 7d and defaults to the configured lifetime.

First success is `201 {invite, token, duplicate:false, linkRecoverable:true}`. The `token` is a fresh cryptographically random 32-byte base64url bearer. It is returned exactly once. The UI constructs a fragment-only join link, displays/copies it explicitly, and never puts it in a query, persistent browser storage, or an automatic outbound share.

An identical retry is `200 {invite, duplicate:true, linkRecoverable:false, message}` without a token. A lost original response is not recoverable from the database: revoke the listed invitation and mint a new operation if the link was not saved. Reusing the operation with a different normalized label or expiry returns `409 CLIENT_OPERATION_CONFLICT`.

Creation checks owner authority, account quota, active-invite quota, operation idempotency, retained-history quota, insertion, and audit within one `BEGIN IMMEDIATE` transaction. A replay does not consume another quota slot or append audit history.

### POST `/api/site-invites/:id/revoke`

Requires the site owner. Body: `{}` or `{clientOperationId}`. Returns `200 {invite, duplicate}`. Revocation is intrinsically idempotent; a repeated revoke does not append an audit row.

Revoking a used invitation disables its receipt replay. It does not delete or disable the already created account, remove memberships, or reverse signup. Its `redeemedAt` remains visible so the owner UI can explain this accurately.

### POST `/api/site-admission/check`

Body: `{token}`. A currently usable invitation and available account quota return `200 {valid:true, expiresAt}`. Check does not consume the invitation or reserve quota. Missing, used, expired, revoked, or no-longer-authorized invitations share the generic `410 INVITE_UNAVAILABLE` response. Check returns no recipient, owner, room, or account identity.

### POST `/api/site-admission/redeem`

Body: `{token, clientOperationId, username, password, name, woka?}`. Username is 3–32 lowercase letters, digits, or underscores. Display name is 1–40 trimmed characters with no control characters. Password is 16–256 characters, with no leading/trailing whitespace or control characters, matching offline account provisioning and existing login normalization. Optional `woka` is a catalog integer from 0 to 31, default 0. Account and profile validation cannot inject authority fields.

First success: `201 {created:true, username, duplicate:false, loginRequired:true}`. A proven retry: the same response with status 200 and `duplicate:true`. Neither response establishes a session.

The durable receipt is the used invitation's account ID, original username, operation hash, and an immutable credential binding. The binding is SHA-256 over the original random salt and salted scrypt output, never a fast hash of the password itself. Retry must provide the same invitation, operation secret, username, and original password, and the account must still retain those credentials. The password is proved against the account's existing salted scrypt credential; no raw password, fast password digest, reversible password record, or bearer is stored in the receipt. Retry does not modify profile values. An account rename or credential change makes the original receipt unusable; ordinary login remains the recovery path.

Receipt replay still requires enabled invite-only admission, the current issuer's bootstrap authority, unexpired invitation lifetime, no revocation, and no current valid session. Successful existing receipts do not require spare account quota. A expired/revoked receipt or a missed response after policy closure is not evidence that signup failed: the client can try ordinary login with the submitted username and password.

## Atomicity and resource bounds

Password work uses asynchronous Node scrypt (16-byte random salt, 64-byte derived key), protected by a per-service bounded concurrency limit. Full capacity rejects with `429 SIGNUP_BUSY`, with no unbounded password queue. The service rechecks invite state, expiry, issuer authority, session identity, username availability, and account quota after every asynchronous password boundary. Final account insertion, invitation consumption, and sanitized audit occur together in `BEGIN IMMEDIATE`.

Concurrent identical redemption operations may initially derive different salts. The loser verifies the committed account's salted credential before returning an existing receipt. Competing operations cannot create another account from the used invitation. Separate SQLite connections share the same transaction and uniqueness constraints; scrypt concurrency/rate budgets themselves are per process. The supported standalone deployment should use one server process; a future multi-process deployment needs an aggregate external resource budget.

Each operation class has a direct socket-address bucket, a global bucket at ten times its configured per-minute limit, and, for valid check/redemption requests, a per-valid-invite bucket. Arbitrary submitted token strings never become bucket keys. The in-memory table has a hard 1,024-bucket ceiling and one-minute expiry; saturation fails closed. Forwarded headers are ignored. `429` errors supply a safe scalar `retryAfter`: 60 seconds for rate limits and 1 second for busy password work, rendered by the app as `Retry-After`.

The 10-second JSON deadline removes listeners and retained chunks, and the server retains its existing 15-second request timeout. This bounds request-body retention without logging partial bodies. Oversized and aborted requests do not create accounts or audit rows.

## Storage, audit, restart, and rollback

The service owns additive `CREATE TABLE IF NOT EXISTS` migrations for `site_admission_invites` and `site_admission_audit`, plus indexes for active counts and bounded creation-order listing. No existing column or table is changed; room `invites`, `world_invitations`, accounts, sessions, and membership semantics remain separate. The migration runs even with the feature disabled but adds no owner/startup requirement beyond the existing public access gate.

Invite rows store only bearer SHA-256 hash, mint-operation SHA-256 hash, owner reference, safe label, timestamps, and optional consumed account, original username, operation hash, and original salted-credential binding. Audit rows append only one `created`, `redeemed`, and `revoked` event per invite, containing event ID, invite ID, actor/account ID, and timestamp. Unique `(invite_id,event)` prevents replay audit growth. No rejected request, credential failure, check, or receipt retry adds an event.

The configured total invitation cap rejects new issuance with `409 INVITE_HISTORY_LIMIT_REACHED`; retained data is not silently pruned. At most three audit rows exist per invitation. Lowering the cap stops new issuance without deleting existing records. Disabled mode and ordinary restarts preserve histories and receipt proofs. There is no automated pruning or destructive downgrade procedure in this feature.

The focused compatibility check runs the unchanged `bc715ff6ccc0c3d2537e4c003cb4a7bb82745a34` application in public, disabled-registration mode against a synthetic database containing a newly admitted account. It checks startup, normal login, unchanged invitation records, absence of implicit memberships, and a subsequent current-code reopen. Run `node tests/site-admission-baseline-compatibility.mjs /path/to/clean/baseline` with that exact approved checkout. This covers the admission tables and account format only. It does not establish compatibility for other feature changes, unknown image digests, a hosted restore, or rolling writers.

Back up the dedicated SQLite database and WAL consistently under the existing operator backup procedure before a future deployment or downgrade. Old code cannot parse `invite-only`, so a compatible rollback must explicitly restore disabled registration. Disabling signup closes mint/check/redeem; it does not remove accounts that were already created. No live activation or deployment is performed by this change.

## Standalone browser journey

The lightweight `/join.html` page serves both invitation redemption and owner management without loading the 3D renderer or requesting media. The owner signs in there to label, create, copy, list, and revoke invitations. The same-origin share link uses `#invite=...`; its blocking head script captures and removes the fragment before UI initialization. The document's referrer policy protects resource requests independently of parser or preload timing. The token and operation proof remain in memory only, and leaving or reloading requires reopening the original invitation.

An external link may enter only through the exact `GET /join.html` document navigation in invite-only mode. The cross-site exception requires `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`, and `Sec-Fetch-User: ?1`. Host and any supplied Origin remain validated. The exception does not cover APIs, query-bearing landing URLs, frames, subresources, or mutations. Browsers without Fetch Metadata retain the existing safe GET policy. The document uses `no-store`, `no-referrer`, a same-origin-only CSP, and no embeds or analytics.

Signup asks for a display name, username, password, and password confirmation. Success clears the password and invite from the page and asks for ordinary login with the username prefilled. An uncertain response freezes the exact submitted values for an explicit same-operation retry. A signed-in visitor chooses whether to keep that account or sign out first. Owner creation retries cannot reveal a lost token; the page explains how to revoke and reissue deliberately. Site admission is kept separate from targeted world invitations throughout.

This standalone entry works independently. Adding its owner action to the full game's account menu and replacing the full game's legacy operator-only onboarding copy are separate integration edits; this change does not modify those reserved application files.

## Verification

`node --test tests/site-admission-config.test.mjs tests/site-admission-service.test.mjs` exercises real SQLite and real asynchronous scrypt, including paused derivation races, single-use consumption, identical retries, competing operations, account and invite limits, bounded durable audit, absence of raw secrets from SQLite/WAL, owner-versus-world authority, guest/account identity rejection, disabled/revoked/expired replay, changed mint payloads, pagination, request deadlines, rate bounds, rollback on audit failure, and two-connection persistence. Test credentials and identities are deliberately synthetic. HTTP integration tests additionally exercise the application's request/security/session boundary and the normal-login journey.
