# Public-source publication checks

Verified on 2026-10-02 against the clean v0.3 source export using Node.js 24.19.0, npm 11.9.0 and packaged Chromium on Linux.

## Passed on this source export

- Clean pinned dependency install: `npm ci --no-audit --no-fund`
- JavaScript syntax: `npm run check`, 48 source files
- Node unit and authenticated API/persistence tests: `npm test`, 76/76
- Browser bundle: `npm run build`
- Rebuilt-package smoke: `npm run verify`, temporary SQLite database, healthy local API, HTML and all generated JavaScript/CSS assets served
- Integrated desktop/mobile-emulation workflow: `npm run test:browser`, 14/14
- Focused social DOM/async checks: `node tests/social.browser.mjs`, 16/16
- Real local-backend social checks: `node tests/social.live.mjs`, 7/7
- Native-media denied-capture/lifecycle probe: `node tests/media-browser.mjs`, stated checks passed
- Authenticated two-client native SDP/cleanup probe: `node tests/media-server-browser.mjs`, stated checks passed

Both native-media probes observed zero ICE candidates. No successful media packets or physical-device results are implied. Tests using fake media objects are separate from real transport evidence.

## Publication hygiene

- Runtime source and source assets were checked against the immutable v0.3 checkpoint's per-file SHA-256 manifest before export
- Only source, tests, docs, lockfile and cleared/in-scope assets are included; no runtime databases, sessions, uploads, credentials, dependency tree, generated bundles, screenshots, raw test logs or private workspace files
- Legacy Pipoya sprites are excluded and ignored; all three bundled font licenses are included
- Browser dependency resolution uses this repository's declared dependencies, without another workspace's packages
- A source scan found no private-key blocks, supported provider-token patterns or private workspace/context references; this is a scoped hygiene check, not a complete security audit
- `.gitignore` checks cover runtime state, local environment files, generated output and excluded sprites

## Limits

- The public checkout still expects optional local-only legacy sprite images. Missing image requests are expected. Passing browser workflows verify behavior, not complete avatar artwork or polished visual quality
- The source checkpoint still needs camera-relative facing, movement, building and visual improvements; persistent native 3D avatar creation is not implemented here
- Full product/source parity, production identity, Matrix, SFU/TURN, external provider integrations, public hosting, multi-instance operation and physical iOS/Android acceptance are not certified
- Additional earlier-checkpoint suites are described in `IMPLEMENTATION-STATUS.md`; they were not all rerun for this filtered publication
- No GitHub Actions workflow or deployment is configured by this initial publication. These are local verification results, not remote CI results
