# Open signup for the dev MVP

Open signup is an explicit option: `UNIVERSE_REGISTRATION_MODE=open`. Public and container defaults remain `disabled`; `local-open` remains forbidden in public mode. Open mode uses the existing `UNIVERSE_SITE_MAX_ACCOUNTS` setting, defaulting to 10,000. No email service, email verification or password reset is included.

`/signup.html` creates an ordinary account, then asks the person to sign in separately. Email is trimmed and lowercased as a product rule. The supported ASCII address subset accepts plus addressing, at most 254 characters overall and 64 in the local part. Email is stored only in the nullable, case-insensitive unique `accounts.email` credential column; public profiles use a generated username. Existing username login still works.

The new email column is created only for new databases. Enabling open signup against an incompatible account schema fails with `OPEN_SIGNUP_SCHEMA_REQUIRED`; it does not migrate that database.

## Initial owner setup

Use a fresh dedicated database and set `UNIVERSE_SETUP_ONLY=1` together with open registration. Initial eligibility is persisted before browser signup. An unfinished setup can restart; an initialized database cannot re-enter setup. Only the signup/login page and its exact assets, account access policy, health, and authenticated account-ID view are available. Game APIs, places, streams and management are unavailable.

The person signs up at `/signup.html`, signs in, and confirms the immutable account ID shown in their own session. Account creation grants no ownership. After that exact ID has been approved, the operator can run the credential-free helper against the existing setup database:

```sh
UNIVERSE_DB=/absolute/path/to/existing/site.sqlite node scripts/promote-owner.mjs EXACT_APPROVED_ACCOUNT_ID
```

The helper accepts an account created in that pending setup, assigns the unowned seed hierarchy and owner memberships, records the bootstrap marker and non-secret audit, and checks readiness in one transaction. A failed check rolls everything back. A repeated promotion fails closed. It does not select by email, accept a password or create credentials.

Restart with `UNIVERSE_SETUP_ONLY=0` while retaining open registration. Keep the same persistent database. Existing offline bootstrap and invite-only behavior remain available for their existing uses.

## Six acceptance checks

1. **Signup and login:** two independent accounts, separate email login, case/whitespace rules, duplicate-email and account-cap races are covered locally. Actual deployed HTTPS is still an operator check.
2. **Email privacy:** identity, chat, direct-message, member, presence, directory and event projections omit credential email; browser signup does not store credentials or put email in URLs.
3. **Ordinary account isolation:** signup grants no ownership or membership. Private places remain inaccessible until separately authorized; public guest visits do not create durable membership.
4. **Restart durability:** local tests preserve accounts, password hashes, pending setup, promoted owner marker, seed ownership and explicit grants through restart. The deployed `/data` mount must be verified by the operator.
5. **Setup and promotion:** the route allowlist, fresh-only eligibility, exact-ID selection, wrong-context/nonexistent IDs, repeated promotion and transactional rollback are covered with synthetic accounts. No real owner was promoted by these tests.
6. **Running deployment:** local tests check request security, Secure-cookie configuration, page headers, unbuffered SSE headers and the actual 15-second heartbeat interval. Published/running digest equality, real TLS proxy access, absence of a public application port and live reconnect behavior require the deployed instance.

Run the existing CPU suite with `npm test` and the old and new account browser journeys with `node scripts/test-browser.mjs signup`. A registered test is not itself a passing result; use the exact workflow run for the tested commit. Image publishing is a separate stacked change and does not activate a host deployment.
