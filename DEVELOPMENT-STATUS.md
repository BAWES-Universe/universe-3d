# Development status · 2026-10-03 00:19 UTC

## Current increment: explicit optional process configuration

The standard entry point can now read `UNIVERSE_PROXIMITY_CONFIG`. Absent or explicit off omits both factory options and preserves the legacy path. Enabling membership requires every policy value, with real JSON booleans/numbers and no unknown or duplicate fields. Nearby text can be enabled only with membership. The reader selects no cap, threshold, scale or deployment defaults; see `PROXIMITY-RUNTIME-CONFIG.md` for field meanings and bounds.

Invalid configuration fails before database creation/mutation or socket binding, and errors omit raw submitted values. The reusable server factory still ignores ambient configuration. Existing Host/Origin/TLS, login-only mode, ICE configuration and media consent keep their separate contracts. No environment file, host, credential or running service was changed.

The 26 focused reader/process tests pass in the integrated tree. The final aggregate passes 926 CPU/API tests with one existing historical skip; all 230 source files pass syntax checks. Build, package startup/static files and Dockerfile-copy reconstruction pass. There is no frontend runtime change in this increment, and the built JS/CSS match the preceding Nearby checkpoint. The preceding Nearby source is frozen for separate publication and its final combined 11 module/7 actual-shell checks passed. Configuration publication must follow that increment; exact-head remote CI remains required.

## Prior increment: live Nearby text independent of media consent

Nearby is a separate mode in Chat, backed by the all-member bubble authority. Microphone consent and the P2P threshold do not select its recipients. The opt-in server relays plain text only to the captured, currently authorized bubble sessions, with server-derived name and saved 3D appearance. Each stream receives its own freshness envelope; another tab sharing the same cookie can receive a labeled own-account copy. The origin gets a verified acknowledgement, rather than an optimistic delivery claim.

Received and acknowledged rows, unread state and drafts remain in this browser tab only. Leaving retains a read-only stay. Reconnection recovers no missed messages and never automatically sends a draft. Full reload or account change clears local Nearby history. Room chat/DMs and avatar Express retain their separate behavior. See `PROXIMITY-TEXT-CONTRACT.md` for the precise adaptation and `PROXIMITY-TEXT-SOURCE.md` for immutable source citations and remaining gaps.

Activation is explicit: `createGameServer({proximityMembershipConfig, proximityTextConfig:{enabled:true}})`. Both features remain off by default; the later process-configuration increment above supplies the same explicit factory options only after full validation. No deployed defaults, relay credentials, provider or SFU are configured by this source change. Named meeting/stage chat, typing, files, Markdown, bot text and Matrix/E2EE are outside this first Nearby slice.

Integrated CPU/API checks pass 900 tests with one existing historical skip. The focused server slice passes 33 HTTP/SQLite/SSE cases, and the client controller passes 38 checks. The Nearby module has 11 passing native browser cases; all 16 existing Social module checks also pass. The actual bundle passes six desktop flows covering two-browser microphone-off text, focus/keyboard/IME/Escape, room travel, real SSE disconnection without replay, inert rendering and reload clearing. A separate final touch replay passes 320px portrait and 700×320 landscape with every computed Nearby text size doubled. Native swipes reveal the composer and Send while Close remains reachable. Syntax, build, package startup/static files and Dockerfile-copy reconstruction pass. The final combined Nearby run passes all 11 native module checks and all 7 actual-shell flows on the final bundle, including the doubled-computed-text touch case. Exact-head publication/CI is pending. No whole source contract or physical-device/media-packet claim follows from these scoped checks.

Final local bundle: main `a3c86dc3406f694748b3c0c8a73cf7e6e64bac556203fbdf23660856e17eca9b`, CSS `6e4116d7c6653f69f38c3a20251ef2e9bf1118dab54e830d43d36bb4cf938adb`.

The durable baseline `f2f9b080ed778a105a87f15490aa439038b6f4bf` passed all nine remote CI jobs. It includes all-member proximity/client lifecycle, strict media freshness, native ICE/SDP probes and the one-file HUD readiness correction. Current Nearby publication and exact-head CI are pending. The normalized parity inventory remains deliberately incomplete and certifies no whole source contract.

## Implemented and locally exercised

- Native 3D character creation and saved appearance, camera-relative movement, Shift2.5×, orbit/pan/zoom/follow, keyboard and touch controls
- Direct snapped building with preview, selection, drag, rotation, undo, persisted scenes and scoped permissions
- Universe/world/room hierarchy, invitations and revocation; local room text/DMs and ephemeral Express
- Functional item/area actions, audio resource lifecycle, HTTPS content panels, protected documents and authored quest slices
- Atomic personal-space claim/transfer/assignment and full old/new object footprint authorization
- Room-scoped PNG definitions and immutable versions, searchable metadata, reversible archive/restore, protected image bytes, alpha-aware placement/picking and collision
- Local resident authoring, ordered patrol, collision-aware movement and permission-checked pause/resume/return
- Private resident tests with durable operation identity, explicit saved permissions, cancellation and uncertain-result handling; synthetic literal-loopback protocol only
- Exact Host/Origin/TLS-cookie policy, login-only public preview mode, offline account provisioning and Node24 persistent-volume files

Tests exercise explicit boundaries and failure cases. Counts overlap and do not represent a feature-completion percentage. No whole Universe source contract is certified by this status file.

## Current limitations

- No real relay or AI/MCP provider is configured. Native ICE configuration and SDP restarts do not prove relay allocation, a connected media path or AV packets
- Default activation still uses the previous cap-four, opted-in graph. The explicit factory opt-in now has all-member proximity membership and a compatible scoped client. No default cap/threshold/scale is chosen; meeting/stage topology and SFU handoff remain unfinished
- Issued TURN credentials are bearer credentials until relay expiry. Local revocation stops issuance/client use; it does not invalidate previously issued credentials at the relay
- One active media tab per account is supported. The existing recipient/signaling graph is account-based even though new credential issuance is session-bound
- Real device capture, physical-phone performance, network handover, operator-run Docker/proxy/TLS, backups and production capacity remain unverified
- Matrix/E2EE/federation, SSO, full quest programs, upstream owned-avatar entitlements, image pixel/geometry version editing, permanent definition deletion and collection import, persistent chunks, reusable primitive workshop, terrain and creator games remain partial or missing

The operator review remains pinned to `93ae7de9f529f252ecba13230369b404a663ef04` until separately updated. Source publication does not change the deployed revision or configure a relay.

## Next

1. Publish this bounded Nearby text increment and verify its exact-head CI
2. Confirm intended proximity cap/threshold/scale before activating the optional policy in an operator build
3. Complete operator-authorized real device/relay acceptance and safe hybrid SFU handoff
4. Continue source-backed parity, including richer proximity text and independent persistent Matrix contracts

The operator review remains pinned to `93ae7de9f529f252ecba13230369b404a663ef04` until separately updated. No deployment or running service modification occurred.
