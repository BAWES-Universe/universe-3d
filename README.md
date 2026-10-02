# Universe 3D: development checkpoint v0.3

An independently runnable local implementation with a playable browser 3D world, authenticated local server, durable building, live room chat, and optional direct WebRTC controls. This is a development build, not a finished source-parity replacement or a deployed Universe service.

## Build and run from source

Requires **Node.js 24 or later** (built-in SQLite) and npm.

```sh
npm ci
npm run build
npm start
```

This public source checkout intentionally excludes the legacy Pipoya Woka sprite PNGs. The source builds and the local server starts without them, but the avatar picker and billboard characters lack their intended artwork and may render blank or untextured. This is an **incomplete development checkpoint**, not a complete out-of-the-box visual release. See [ASSETS.md](ASSETS.md) for the separate asset prerequisite and restrictions. Native 3D characters and a persistent avatar builder are in development separately; they are not implemented by this checkpoint.

Generated `dist/`, local databases, sessions, uploads, test output and dependency directories are not versioned. Rebuild `dist/` before starting the server.

Open http://127.0.0.1:4190 in a browser. The first guest on a fresh database becomes owner of the seeded world. Additional public visitors are guests without durable world membership; authorized managers can grant explicit world membership and roles from Places. To test distinct users, use separate browser profiles or an incognito window.

Data lives in `data/universe.sqlite`. Keep that directory across server restarts. Create a local account in You before clearing browser cookies if you need to recover your identity. This development server has no email, password-recovery, SSO or public deployment setup. It binds to loopback and rejects non-loopback Host headers intentionally.

## Play

- WASD / arrow keys: walk; Shift: run
- Click the ground: pathfind; click nearby functional furniture or press E: interact
- Touch devices: left-hand movement pad, tap ground and controls
- Camera: + / − to zoom, circular arrow to rotate
- Explore: enter connected rooms or create worlds/rooms you own
- Chat / People: room history, DMs, expressions, status, moderation and access
- Build (owner/editor): place furniture, edit properties, area behaviors, undo/redo, save/export/import
- Connect: explicitly opt into available microphone, camera or screen capture

The legacy renderer expects Woka sprite sheets displayed as animated billboards in the 3D world. Those third-party images are excluded from this public checkout. The low-poly architecture/furniture and room layouts are original procedural implementation assets. The BAWES brand mark and fonts retain their own ownership and license terms; provenance and font license texts are in `ASSETS.md` and `public/assets/licenses/`.

## Real service behavior and current trust boundary

This server uses random HttpOnly session cookies, SQLite, role checks on every protected mutation, compare-and-swap scene revisions, and room-scoped SSE. It is not a fixture role dropdown. Local accounts use salted scrypt password hashing. Server API details and limits are in `server/API.md`.

Room chat and local DMs are independent native services. They are **not** Matrix, Matrix E2EE, federation, or a migrated Matrix history. Presence positions are client-reported within validated room bounds; this is not a hardened authoritative physics/anti-cheat server. Direct peer media uses server-authorized signaling and direction checks, but is not a hardened SFU.

**Media remains a deployment/device acceptance gate.** The cloud browser created native SDP and followed authorization/cleanup correctly, but produced zero ICE candidates. No successful end-to-end audio/video packets, physical phone capture, TURN traversal or network handover have been verified. The UI reports real capture/transport failure instead of pretending a call connected. No external ICE service is configured. Use one active media tab per account.

## Rebuild and tests

```sh
npm ci
npm run check
npm test
npm run build
npm run verify
# Optional browser coverage, using packaged Linux Chromium:
npm run test:browser
```

The pinned dependencies are in `package.json` / `package-lock.json`. Browser test helper uses installed Playwright and packaged Chromium; workspace-only fallback paths are unnecessary after installing the declared dev dependencies. `tests/` distinguishes pure/fake-media unit tests, DOM fixtures, native browser probes, and real authenticated multi-client integration checks. Tests generate local output in ignored `evidence/`. The public checkout does not contain prior screenshots or raw test logs. Browser tests are intended for Linux with the packaged Chromium. Passing workflow checks does not certify the omitted sprite artwork or the unfinished visual quality.

Full feature parity has not been certified; this checkpoint implements only a subset of the original product contracts. Missing source-stack integrations, catalogs/admin breadth, bots/MCP/provider configuration, richer generated worlds, cross-device/physical-device evidence and operational rollout are still substantial work.

## Additional implemented slices

- Multiple actions on one area: message, website/document link, opt-in audio, and explicit room travel, alongside the primary meeting/quiet/stage policy. Effects reconcile when boundaries change and stop on exit. Source-level ACL-per-action and every integration are not complete.
- Authenticated room documents: editor upload, protected attachment download, selection from uploaded documents, server-side 5 MiB/file validation, recoverable deletion/restore APIs. This is not an asset marketplace or area-tag file ACL.
- Optional authored quests: Explore a named area, Build through a committed authorized save, and Meet only when a real opted-in proximity peer makes it completable. Explicit acceptance, one tracked quest, cancelable guidance, per-user durable private stamps. The complete upstream quest program, owner authoring workflow and every guest merge contract are not implemented.

## Repository status and licensing

`main` begins with this clean, incomplete v0.3 source checkpoint. Ongoing camera, movement, building, texture and native-3D-avatar improvements belong on a separate review branch until verified. This publication does not deploy a server, alter production services or configure external AI/media providers.

No project-wide open-source license is assigned by this initial publication. Public visibility does not relicense the project, brand marks or third-party components. See [ASSETS.md](ASSETS.md) for their separate terms. The initial repository contains no CI workflow; local verification is recorded in [REPOSITORY-CHECKS.md](REPOSITORY-CHECKS.md).
