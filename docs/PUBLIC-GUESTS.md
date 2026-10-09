# Bounded public exploration

Public mode with `UNIVERSE_REGISTRATION_MODE=open` and `UNIVERSE_SETUP_ONLY=0` offers **Explore as guest**. Name and account creation are optional. Disabled/invite-only public sites remain login-only; pending owner setup retains its strict allowlist. Local development guests retain their existing seed-owner behavior and are never reclassified.

## Server authority

A process-local registry identifies public guests explicitly. Creating a visitor never calls `Store.createUser`, touches seed ownership or adds SQLite profiles, accounts, sessions or memberships. Every parent and destination room must be public and unarchived; bans still apply. Room/world grants and persistent DMs targeting guests are refused.

Guests can look, walk, jump, sit, join/leave public rooms, use in-world expressions, Nearby text/typing, controlled-follow and opt-in audio/video, and resolve saved read-only room actions. Configured public bot text is separately bounded. See [guest conversations](GUEST-CONVERSATIONS.md). The server allowlists those operations and fails closed for all other or future endpoints. Existing movement/admission checks remain authoritative. Guest admissions are always strict and are kept in memory, with no persistent session-guard rows.

Guests cannot build, upload, create places, change saved profiles, save chat/DMs/stars/quests, claim spaces, redeem invitations, administer residents/members. Account creation enables a saved identity and creating one's own places; it does not grant editing or private access to the current room.

Guest snapshots, People and SSE show live authorized room occupants using minimal display/appearance fields. They omit account usernames, durable roles and membership tags. Only the recipient's own presence retains its admission tuple, so privacy filtering cannot cause an arrival reconciliation loop. Public personal-area labels can still identify their owner by display name, but never expose their account username. Saved chat/history, upload catalogs and edit journals are withheld. Image bytes must match a currently pinned scene version; documents require a saved room link and current guest admission. Pinned updates reload room definitions without requesting a forbidden image catalog.

## Lifetime, reconnect and account transition

- Fixed maximum lifetime: 24 hours; maximum population: 512; existing 60/IP/minute creation rate limit also applies
- Random opaque HttpOnly browser-session cookie; SameSite=Strict, public Secure-cookie and Host/Origin checks are unchanged
- Reload/SSE reconnect retain valid process-local identity and reauthorize arrival; no credentials enter local storage
- Logout, expiry or successful account login retire guest sessions, presence, SSE, admission and temporary moderation
- Expired/sessionless profiles are forgotten during the 15-second sweep and before new guest allocation
- Restart forgets all visitors; the preserved room/entry URL permits one-click fresh guest re-entry
- Signup creates a separate ordinary account and fences the guest session across async hashing; it never upgrades the guest ID or copies grants
- Failed/interrupted login leaves a valid guest visit usable; setup/me requires a real account
- The existing strict signup destination contract carries room/entry/invitation fields, never arbitrary return URLs or post-signup privileges

## Release and rollback

No guest schema migration, persistent guest cleanup or purge is needed. Registered accounts, their SQLite write/CAS paths, ownership and memberships stay on the existing tables. The explicit principal adapter is limited to session/room/SSE, action/image-read and occupancy checks; it does not virtualize SQL or shadow tables. Guest moderation is in memory. Old-image readiness continues to reject unmarked unprovisioned profiles normally.

Rebuild static assets and restart for release. Restart/rollback lose only guest leases; account data remain intact. No new secrets, providers, capture or host changes are introduced by this patch. All implementation checks use synthetic local databases; no deployment database was read or modified.

## Verification

`tests/public-guests.test.mjs` covers permission negatives, public/private hierarchy, caps, expiry, moderation, permanent-table equality, restart lease loss, account-transition fencing/SSE retirement, scoped public projections, pinned-only content and self-admission ordering.

`tests/public-guests.full.mjs` always exercises real HTTP/SQLite and native external links on desktop, 320×568 portrait and 667×375 landscape, including guest entry, idle background calls, reload/reconnect, restart→named destination and account transition. Desktop movement uses native keyboard input. The touch cases require visible native Sit/Stand controls on both movement sides and four simultaneous pointers for movement, camera gestures and Jump. `tests/public-guest-entry.full.mjs` separately checks unscrolled first-fold guest entry and native keyboard access to optional fields and account controls at both touch sizes. These are software-WebGL and viewport/touch-emulation checks, not physical-phone certification.
