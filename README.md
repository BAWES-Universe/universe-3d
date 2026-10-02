# Universe: standalone 3D game

An independently runnable browser game with a real authenticated local server, persistent places and building, native 3D characters, room chat and optional direct WebRTC controls. This is an active development implementation, not a finished full-parity replacement for the existing Universe service.

## Run from source

Requires **Node.js 24 or later** (built-in SQLite):

```sh
npm ci
npm run build
npm start
```

Open http://127.0.0.1:4190. No legacy sprite files are needed. If you received a prebuilt package that already contains `dist/`, `node server.mjs` runs it without installing dependencies.

In local development mode, the first guest on a fresh database owns the seeded places. Later public visitors remain transient guests; visiting does not silently create durable membership. Use separate browser profiles to test different people. The owner can administer real Universe → World → Room membership and access in Manage.

Data lives in `data/universe.sqlite`. Keep it across restarts. Create a local account in You to recover your character and identity after clearing cookies. There is no email/password recovery or SSO. Local development defaults to loopback and exact loopback Host checks. For the separate private dev preview, explicit public-mode Host/Origin/TLS settings, offline owner/reviewer provisioning and a dedicated persistent volume are supplied. Read `DEV-PREVIEW-OPERATOR.md` before exposing the app; changing only the listen address is unsafe.

## Play and create

- **Move:** WASD / ZQSD / arrows, relative to the camera. Hold Shift for 2.5× manual fast walk. Click the ground to pathfind; Shift does not accelerate automatic paths. Diagonals are normalized.
- **Camera:** drag to orbit; right-drag also orbits. Wheel or +/− zooms. Middle-drag / Shift-right-drag pans. `[ ]` orbits, Page Up/Down tilts, F follows, Home resets. Pan mode gives arrows to the camera. Touch: two fingers orbit/pinch, three fingers pan; joystick moves the character.
- **Interact:** Space on key release, or click nearby functional furniture. Stored documents download through authenticated access checks.
- **Build:** E (B is an alias). Choose furniture, inspect the snapped footprint, rotate with R, click or Space to place. Select and drag to move; V selects, X erases, D duplicates, Delete removes. Arrows move the preview or selection; `[ ]` cycles selection. Undo/redo uses Cmd/Ctrl Z / Shift Z; save uses Cmd/Ctrl S. Escape cancels the current operation before closing.
- **Custom images:** open Build → Custom images. Choose a PNG, name/tag it, choose a floor or upright representation and optional collision cells, then explicitly Upload. Search the room library and place a pinned reusable instance. Drag, quarter-turn, duplicate and Save work as with furniture. Images stay flat; they are not converted into 3D meshes. See `CUSTOM-IMAGES.md` for limits and current lifecycle gaps.
- **Express:** Enter on key release opens Say; Ctrl+Enter opens Think. Think is visible to others, not a private note. Favorites use 1–6. Room chat is a separate durable conversation.
- **Direct sections:** C Chat, U People, G Explore, J Quests, P You, M Connect, L Personal spaces, N Bots when authorized. Cmd/Ctrl K searches actual actions, people and places. `?` or F1 opens the shortcut guide.
- **Personal spaces:** managers configure dynamic/static personal areas in Build. Registered eligible users can claim or transfer a dynamic space, then edit objects only within its full footprint. L reopens the area controls; Cmd/Ctrl D walks to your first desk in the current room at 2.5× speed. Managers can assign/revoke with explicit object-retention choices.
- **Residents:** eligible universe owners and world admins/editors can open Bots, choose a native 3D appearance, set home/radius and ordered patrol points, then explicitly create the resident. Closing a new draft keeps it in the current tab; reload or sign-out clears that local draft. Existing resident field changes save on Back/Close. Native scene handles and the plan/numeric controls edit the same draft. Disabled residents stay in the catalog. Local pause/resume/return controls obey their saved permissions. Provider-free social residents remain silent.
- **Your character:** open You → Edit your 3D character. Change body proportions, hair, clothing and accessories in a real 3D preview. Save persists the account appearance and updates people in the room. Cancel leaves the saved appearance unchanged.

Visible controls support Tab / Shift Tab and native Enter / Space. Text fields and IME composition suppress world shortcuts. Escape and browser Back dismiss surfaces; Forward restores supported surfaces. Touch and short-height layouts are covered by browser emulation, not a physical-device certification.

## Implemented service slices

- Cookie-authenticated local accounts, salted scrypt password hashes, scoped server authorization and room-scoped SSE
- Durable scenes with compare-and-swap revisions, conflict recovery, undo/redo and draft export
- Hierarchical places, explicit scoped roles/tags, targeted local-account invitations, privacy-filtered discovery, stars, archive/restore and immediate revocation
- Ordered item and area actions with named messages, links/downloads, audio controls and explicit room travel; saved actions are reauthorized at activation
- Closable sandboxed external panels with a persistent new-tab fallback, and audio volume/mute/pause/retry plus source/area/room cleanup
- Atomic personal-space claims/transfers/assignment/revocation, server-checked old/new object footprints and scoped builder recovery
- Durable resident configuration and server-owned occupancy/patrol lifecycle, separate from real-person chat, quests and media graphs
- Authenticated room documents: 5 MiB/file validation, safe attachment downloads, editor attachment, recoverable delete/restore
- Optional authored quests: named-area exploration, committed authorized building and reciprocal waves with real opted-in proximity peers; private durable stamps
- Persistent local room chat and DMs, plus separate ephemeral in-world Say/Think/reactions
- Room-scoped immutable PNG assets with authenticated bytes, search, reusable version-pinned instances, transparent-pixel picking and shared collision/edit-footprint geometry
- Original procedural 3D characters, environment materials and furniture, without a restricted sprite dependency

These are partial source-contract implementations. In particular, local chat is not Matrix/E2EE/federation; the free original wardrobe is not a migration of upstream owned catalogs; room-only file access is not complete area-tag authorization; quest authoring and guest merge semantics remain incomplete. AI-provider conversations and external MCP/tool connections, infinite persistent chunks, an asset workshop/marketplace, creator game-logic systems and external provider/admin integrations remain unfinished. Bot authoring and local movement permissions do not imply an AI provider is connected.

## Trust and media limits

Positions are validated client reports, not authoritative server physics or anti-cheat. The local service is one long-lived process with SQLite and in-memory live state; it is not yet horizontally distributed.

**Media is still an acceptance gate.** Native SDP, signaling authorization and cleanup were tested, but the cloud browser yielded zero ICE candidates. Successful end-to-end audio/video packets, TURN traversal, physical-phone capture and network handover have not been verified. No external SFU/TURN service is configured. The optional server-side ICE adapter now supports validated operator configuration, session-scoped temporary credentials and native renewal/restart; see `P2P-ICE-ADAPTER.md` for configuration and bearer-credential limits. Silent areas stop outgoing capture and incoming spatial calls, including overlapping meeting areas; room text chat and authored ambient sounds are separate. Leaving Silent never automatically turns a device on. The UI reports real failures rather than claiming a connected call. Use one active media tab per account.

The code includes exact Host/Origin checks, explicit Secure-cookie policy behind external TLS, fail-closed public startup, login-only preview admission, offline account provisioning and a Node24 container definition. An operator must still build/run the image, verify proxy/TLS, quotas, backups and real media adapters. No deployment or existing dev resource mutation has occurred. See `DEV-PREVIEW-OPERATOR.md` and `HOSTING-READINESS.md`.

## Checks

```sh
npm run check
npm test
npm run build
npm run verify
npm run verify:container-files
npm run test:browser
npm run test:browser:modules
npm run test:browser:authoring
npm run test:browser:images
npm run test:browser:media
```

Core browser tests run serially through the actual shell for camera, direct building, character persistence, Express and WebGL-unavailable fallback. Module tests separately cover fixtures and media-policy/lifecycle behavior. Browser tests use Chromium software WebGL; local results do not certify physical phones or production capacity. Old test scripts remain as historical probes and are not implicitly passing checks.

`npm run record:walkthrough` records actual keyboard/pointer flows (requires ffmpeg). `npm run measure:server` makes a bounded local server/asset measurement, not a user-capacity claim. CI runs the same check/unit/build/package/core-browser commands; verify the exact remote commit's status before treating it as green.

Asset provenance and license texts are in `ASSETS.md` and `public/assets/licenses/`. No blanket open-source license or trademark reuse permission is granted by this repository. The original research and prototype remain separate and unchanged.
