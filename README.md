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

The first guest on a fresh database owns the seeded places. Later public visitors remain transient guests; visiting does not silently create durable membership. Use separate browser profiles to test different people. The owner can administer real Universe → World → Room membership and access in Manage.

Data lives in `data/universe.sqlite`. Keep it across restarts. Create a local account in You to recover your character and identity after clearing cookies. There is no email/password recovery or SSO. The development server intentionally binds to loopback and rejects non-loopback Host headers. Do not expose it by simply changing the listen address.

## Play and create

- **Move:** WASD / ZQSD / arrows, relative to the camera. Hold Shift for 2.5× manual fast walk. Click the ground to pathfind; Shift does not accelerate automatic paths. Diagonals are normalized.
- **Camera:** drag to orbit; right-drag also orbits. Wheel or +/− zooms. Middle-drag / Shift-right-drag pans. `[ ]` orbits, Page Up/Down tilts, F follows, Home resets. Pan mode gives arrows to the camera. Touch: two fingers orbit/pinch, three fingers pan; joystick moves the character.
- **Interact:** Space on key release, or click nearby functional furniture. Stored documents download through authenticated access checks.
- **Build:** E (B is an alias). Choose furniture, inspect the snapped footprint, rotate with R, click or Space to place. Select and drag to move; V selects, X erases, D duplicates, Delete removes. Arrows move the preview or selection; `[ ]` cycles selection. Undo/redo uses Cmd/Ctrl Z / Shift Z; save uses Cmd/Ctrl S. Escape cancels the current operation before closing.
- **Express:** Enter on key release opens Say; Ctrl+Enter opens Think. Think is visible to others, not a private note. Favorites use 1–6. Room chat is a separate durable conversation.
- **Direct sections:** C Chat, U People, G Explore, J Quests, P You, M Connect. Cmd/Ctrl K searches actual actions, people and places. `?` or F1 opens the shortcut guide.
- **Your character:** open You → Edit your 3D character. Change body proportions, hair, clothing and accessories in a real 3D preview. Save persists the account appearance and updates people in the room. Cancel leaves the saved appearance unchanged.

Visible controls support Tab / Shift Tab and native Enter / Space. Text fields and IME composition suppress world shortcuts. Escape and browser Back dismiss surfaces; Forward restores supported surfaces. Touch and short-height layouts are covered by browser emulation, not a physical-device certification.

## Implemented service slices

- Cookie-authenticated local accounts, salted scrypt password hashes, scoped server authorization and room-scoped SSE
- Durable scenes with compare-and-swap revisions, conflict recovery, undo/redo and draft export
- Hierarchical places, explicit scoped roles/tags, targeted local-account invitations, privacy-filtered discovery, stars, archive/restore and immediate revocation
- Multiple area actions including messages, website/document links, opt-in audio and explicit room travel, alongside quiet/meeting/stage policies
- Authenticated room documents: 5 MiB/file validation, safe attachment downloads, editor attachment, recoverable delete/restore
- Optional authored quests: named-area exploration, committed authorized building and reciprocal waves with real opted-in proximity peers; private durable stamps
- Persistent local room chat and DMs, plus separate ephemeral in-world Say/Think/reactions
- Original procedural 3D characters, environment materials and furniture, without a restricted sprite dependency

These are partial source-contract implementations. In particular, local chat is not Matrix/E2EE/federation; the free original wardrobe is not a migration of upstream owned catalogs; room-only file access is not complete area-tag authorization; quest authoring and guest merge semantics remain incomplete. Bots/AI/MCP, infinite persistent chunks, an asset workshop/marketplace, creator game-logic systems and external provider/admin integrations are not delivered here.

## Trust and media limits

Positions are validated client reports, not authoritative server physics or anti-cheat. The local service is one long-lived process with SQLite and in-memory live state; it is not yet horizontally distributed.

**Media is still an acceptance gate.** Native SDP, signaling authorization and cleanup were tested, but the cloud browser yielded zero ICE candidates. Successful end-to-end audio/video packets, TURN traversal, physical-phone capture and network handover have not been verified. No external SFU/TURN service is configured. The UI reports real failures rather than claiming a connected call. Use one active media tab per account.

Hosting requires an isolated service/data directory, TLS-aware secure-cookie/origin configuration, quotas/backups and verified media adapters. Existing Universe dev resources may be reusable after a separate operator assessment; this code does not configure or mutate them. See `HOSTING-READINESS.md`.

## Checks

```sh
npm run check
npm test
npm run build
npm run verify
npm run test:browser
npm run test:browser:modules
```

Core browser tests run serially through the actual shell for camera, direct building, character persistence, Express and WebGL-unavailable fallback. Module tests separately cover fixtures and media-policy/lifecycle behavior. Browser tests use Chromium software WebGL; local results do not certify physical phones or production capacity. Old test scripts remain as historical probes and are not implicitly passing checks.

`npm run record:walkthrough` records actual keyboard/pointer flows (requires ffmpeg). `npm run measure:server` makes a bounded local server/asset measurement, not a user-capacity claim. CI runs the same check/unit/build/package/core-browser commands; verify the exact remote commit's status before treating it as green.

Asset provenance and license texts are in `ASSETS.md` and `public/assets/licenses/`. No blanket open-source license or trademark reuse permission is granted by this repository. The original research and prototype remain separate and unchanged.
