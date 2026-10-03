# Development status · 2026-10-03 02:38 UTC

## Current increment: native terrain workbench

The terrain checkpoint was published as `65f2a3e3531f49fb2899f4cf88095b2bdfa7b99e`. Its exact-head CI passed nine jobs and exposed two compact-layout regressions: the 320px toolbelt gained a third row, and an unnecessarily raised palette obscured the initial 1000px/DPR2 selection fixture. The focused correction moves Room settings beside Done, keeps 12 toolbelt controls in two rows with 45.5px minimum width at 320, and restores the medium palette offset to 701–850px. Both original regression suites pass unchanged; an additional eight-case native toolbar fixture covers reachability, target sizes, Terrain→Custom→Save and keyboard Room access. The 14 terrain editor fixture cases also pass. Publication/CI for this correction remain pending.

Build now paints snapped rectangles of grass, soil, stone, wood or water. Appearance and blocking are explicit; water starts blocked, with no swimming. Restore base removes authored cells and restores the original paving/ground/planting. A straight wall stroke creates an ordinary wall that remains selectable, movable and rotatable. Pointer previews do not mutate the scene; one completed stroke is one undo transaction. Keyboard sizing, native focus/activation and touch/camera cancellation use the same editor path.

The sparse versioned ground layer fits the existing room scene/CAS save, with a 4,096-cell budget and existing scene JSON limits. Full room editors can paint; scoped personal-space grants remain object-only. New terrain and changed wall blockers reject occupied positions and protect arrival without moving people. Player movement/click paths and resident navigation share the cells. A rejected occupancy save now displays its actual cause while keeping the retryable draft; a genuine revision conflict retains normal recovery. Build Enter is consumed before Express keyup handling.

Authored patches replace affected baked scenery cleanly. Water animates a shared procedural texture; the 4,096-cell renderer fixture uses five terrain surface batches. Erasing restores the legacy composition, and worlds without terrain retain the original path. This is a requested native 3D extension informed by pinned source layer/collision contracts. It does not implement Tiled import, elevation, swimming, streamed chunks, uploaded terrain textures or the primitive workshop. Water currently reads as a flat animated painted surface; shoreline transitions, depth and rounded edges remain visual improvements for a later increment. See `TERRAIN-WORKBENCH.md` and `docs/terrain-contract.md`.

Final local aggregate passes 1,096 CPU/API tests with the same historical skip; all 249 source files pass syntax checks. Build, package startup/static files and Dockerfile-copy reconstruction pass. Final browser verification passes 14 native editor cases, 9 renderer cases, 7 actual two-client/desktop/touch scenarios, 3 native full-shell Enter lifecycle checks and all 5 existing Express full-shell cases, with no page exceptions. The final main bundle is `e689c2fed2f185b13473ff3ee05a151015ff2f5077d5e8e2db6e96b4365d4c2d`; CSS is `9d41f047b3c38bfef73d0fca935d57e05ba794c8bfddc8f582e1923515f84b00`. Headless software-WebGL, fixture query/draw counts and emulated touch do not establish physical-device performance or production capacity.

Baseline `b733ab2c532e31e7eb99f315eebd8b5b9b32aa62` passed all ten exact-head CI jobs. Terrain source is published; the compact-layout correction above addresses its two CI failures. No deployment, live configuration or credential changes were made.

## Prior increment: ephemeral human Nearby typing

Optional Nearby text now shows live human typing in the current ordinary bubble. Fresh input or IME activity starts a bounded per-stream lease; focus, restored drafts, reopening or reconnecting do not. No draft body, history row, unread count, replay or text receipt is created. Mic consent remains independent. Room-muted members can still receive typing, while their own outgoing typing stops. Personal blocking, bot/script typing and named-meeting typing remain separate gaps.

The server validates the current source and each captured recipient at delivery, preserves sequence high-water marks through stop/expiry, bounds state and quotas, and cleans up on session/room/authority changes. Same-account tabs aggregate without one stop erasing a sibling. The client uses an SSE server-time anchor plus monotonic time so device clock skew cannot suppress or extend indicators. A stale text acknowledgement cannot clear newer activity or replace a newer draft. The status line preserves native focus, cursor, transcript and layout. See `NEARBY-TYPING-CONTRACT.md` and the immutable source links in `NEARBY-TYPING-SOURCE.md`.

Final local aggregate: 1,059 CPU/API passes and the same one historical skip; all 238 source files pass syntax checks. Build, package startup/static files and Dockerfile-copy reconstruction pass. The final combined Nearby browser run passes all 27 native fixture cases and 13 actual-shell scenarios. It includes two clients with opposite 60-second device clock offsets, native keyboard/IME and doubled-text touch layouts, late text acknowledgement, room travel, and a real 12-second lost-stop expiry. The server suite also verifies muted-recipient start/renew/stop and sender-mute cleanup. All browser runs report no page exceptions. The final bundle hashes are main `b08e2a671b0399f05eeef89c6524efe9b496f2bd0d80df111273d5d1f7aae312`, CSS `cd4b8a966c37a65e3b9419ceb7cd25e89efb9ac109bf4c19d1da1e2361bd4f53`. No physical-device, successful AV packet or whole-source-contract certification follows from these checks.

Baseline `71800a575aec7113c3de3de9c3f4003cf8d1c72c` passed all ten exact-head CI jobs. Typing was published as `b733ab2c532e31e7eb99f315eebd8b5b9b32aa62` and passed all ten exact-head CI jobs. Optional membership/text stay off until explicitly configured, and no live host, environment or credential changed.

## Prior increment: bounded Nearby context refresh cost

Nearby context refresh now captures membership once per room, completes that room before capturing another, and rereads each accepted session and its ACL. Fresh text submission and recipient checks immediately before body emission are unchanged. Nested refresh, retirement, registration or close invalidates an older metadata refresh; failed/stale batches clear affected context instead of reusing prior authority. This changes synchronous metadata work, not cached message authorization.

Real local HTTP/SQLite/SSE checks at 6, 20 and 50 accounts show that Nearby adds N membership session enumerations per presence update, replacing the prior N² overhead. Text-on total Store.all calls fell from 47/425/2,555 to 17/45/105. Bounded server-handler medians fell from 11.4/54.2/309.8ms to 9.1/30.6/92.5ms on the shared local host. Other handler work remains costly; these measurements do not establish production capacity. The exact fixture and limitations are described in `PROXIMITY-TEXT-CONTRACT.md`.

The isolated exact-source aggregate passes 952 CPU/API checks with the same one historical skip. Syntax, build, package startup/static files and Dockerfile-copy reconstruction pass. Final integrated Nearby browser regression passes all 11 module-native and 7 actual-shell scenarios, including doubled-text native touch. The frontend bundle is unchanged. This refresh correction was published as `71800a575aec7113c3de3de9c3f4003cf8d1c72c` and passed all ten exact-head CI jobs.

Baseline `70aa4377cbaf913d6f20270f1e96f19f3c3b8f77` passed all ten remote CI jobs. Optional membership/text remain off unless explicitly configured; no live values or credentials changed.

## Prior increment: explicit optional process configuration

The standard entry point can now read `UNIVERSE_PROXIMITY_CONFIG`. Absent or explicit off omits both factory options and preserves the legacy path. Enabling membership requires every policy value, with real JSON booleans/numbers and no unknown or duplicate fields. Nearby text can be enabled only with membership. The reader selects no cap, threshold, scale or deployment defaults; see `PROXIMITY-RUNTIME-CONFIG.md` for field meanings and bounds.

Invalid configuration fails before database creation/mutation or socket binding, and errors omit raw submitted values. The reusable server factory still ignores ambient configuration. Existing Host/Origin/TLS, login-only mode, ICE configuration and media consent keep their separate contracts. No environment file, host, credential or running service was changed.

The 26 focused reader/process tests pass in the integrated tree. The final aggregate passes 926 CPU/API tests with one existing historical skip; all 230 source files pass syntax checks. Build, package startup/static files and Dockerfile-copy reconstruction pass. There is no frontend runtime change in this increment, and the built JS/CSS match the preceding Nearby checkpoint. The preceding Nearby checkpoint `b56e7bf09c7e59931dea8386e7e906af4d099fc1` and configuration checkpoint `70aa4377cbaf913d6f20270f1e96f19f3c3b8f77` each passed all ten exact-head remote CI jobs.

## Prior increment: live Nearby text independent of media consent

Nearby is a separate mode in Chat, backed by the all-member bubble authority. Microphone consent and the P2P threshold do not select its recipients. The opt-in server relays plain text only to the captured, currently authorized bubble sessions, with server-derived name and saved 3D appearance. Each stream receives its own freshness envelope; another tab sharing the same cookie can receive a labeled own-account copy. The origin gets a verified acknowledgement, rather than an optimistic delivery claim.

Received and acknowledged rows, unread state and drafts remain in this browser tab only. Leaving retains a read-only stay. Reconnection recovers no missed messages and never automatically sends a draft. Full reload or account change clears local Nearby history. Room chat/DMs and avatar Express retain their separate behavior. See `PROXIMITY-TEXT-CONTRACT.md` for the precise adaptation and `PROXIMITY-TEXT-SOURCE.md` for immutable source citations and remaining gaps.

Activation is explicit: `createGameServer({proximityMembershipConfig, proximityTextConfig:{enabled:true}})`. Both features remain off by default; the later process-configuration increment above supplies the same explicit factory options only after full validation. No deployed defaults, relay credentials, provider or SFU are configured by this source change. Named meeting/stage chat, typing, files, Markdown, bot text and Matrix/E2EE are outside this first Nearby slice.

Integrated CPU/API checks pass 900 tests with one existing historical skip. The focused server slice passes 33 HTTP/SQLite/SSE cases, and the client controller passes 38 checks. The Nearby module has 11 passing native browser cases; all 16 existing Social module checks also pass. The actual bundle passes six desktop flows covering two-browser microphone-off text, focus/keyboard/IME/Escape, room travel, real SSE disconnection without replay, inert rendering and reload clearing. A separate final touch replay passes 320px portrait and 700×320 landscape with every computed Nearby text size doubled. Native swipes reveal the composer and Send while Close remains reachable. Syntax, build, package startup/static files and Dockerfile-copy reconstruction pass. The final combined Nearby run passes all 11 native module checks and all 7 actual-shell flows on the final bundle, including the doubled-computed-text touch case. This earlier Nearby checkpoint subsequently passed all ten exact-head CI jobs. No whole source contract or physical-device/media-packet claim follows from these scoped checks.

Final local bundle: main `a3c86dc3406f694748b3c0c8a73cf7e6e64bac556203fbdf23660856e17eca9b`, CSS `6e4116d7c6653f69f38c3a20251ef2e9bf1118dab54e830d43d36bb4cf938adb`.

The durable baseline `f2f9b080ed778a105a87f15490aa439038b6f4bf` passed all nine remote CI jobs. It includes all-member proximity/client lifecycle, strict media freshness, native ICE/SDP probes and the one-file HUD readiness correction. Nearby and the optional process configuration are now published with exact-head CI green. The normalized parity inventory remains deliberately incomplete and certifies no whole source contract.

## Implemented and locally exercised

- Native 3D character creation and saved appearance, camera-relative movement, Shift2.5×, orbit/pan/zoom/follow, keyboard and touch controls
- Direct snapped building with preview, selection, drag, rotation, undo, persisted scenes and scoped permissions; sparse floor/water painting, restore-base and ordinary wall strokes
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
- Matrix/E2EE/federation, SSO, full quest programs, upstream owned-avatar entitlements, image pixel/geometry version editing, permanent definition deletion and collection import, persistent chunks, reusable primitive workshop, terrain elevation/custom materials and creator games remain partial or missing

The operator review remains pinned to `93ae7de9f529f252ecba13230369b404a663ef04` until separately updated. Source publication does not change the deployed revision or configure a relay.

## Next

1. Publish the native terrain workbench and verify its exact-head CI
2. Confirm intended proximity cap/threshold/scale before activating the optional policy in an operator build
3. Complete operator-authorized real device/relay acceptance and safe hybrid SFU handoff
4. Continue larger world-creation and social-play parity gaps and port the next verified source control changes

The operator review remains pinned to `93ae7de9f529f252ecba13230369b404a663ef04` until separately updated. No deployment or running service modification occurred.
