# Editor polish integration

Base: `bc715ff6ccc0c3d2537e4c003cb4a7bb82745a34`.
Branch: `external/editor-polish`. Local work only.

## Slice

1. Sheet-local selection, snap and placement feedback stays readable on compact screens. Invalid inspector coordinates are rejected immediately and retain their reason. Duplicate previews no longer overwrite an overlap warning with a placement instruction. Rejected keyboard nudges no longer report success.
2. Undo/Redo show available history counts on desktop, action descriptions in compact More tools, and descriptive tooltips/accessibility descriptions. Descriptions come from existing rebased snapshots; no scene metadata or history transaction boundaries change. Repeated UI updates cache those descriptions.
3. Focused buttons, links, summaries and menu controls own their arrow/letter/delete keys. Native Space/Enter activation, explicit Save and Undo shortcuts remain. Closing furniture, terrain or item sheets restores canvas focus without opening a text keyboard. Grid changes cancel the complete pending drag.
4. Inspector actions use larger targets and the existing typography, surfaces and state colors. Compact selection help is consolidated beside the controls. Tool buttons expose pressed/expanded state. No renderer changes or new icon/font/theme dependencies.

## Ownership and integration

Only `src/editor.js`, `src/editor.css` and uniquely prefixed tests/docs/evidence are changed. No shell, renderer, media, server, schema, package, CI or asset-workshop files are changed. No cross-owner integration patch is required. Apply to the exact base with `git apply --check editor-polish.patch`, then `git apply editor-polish.patch`; inspect any conflicts if integrating onto a newer branch.

Explicit Save, immutable image pins, object/terrain/area permissions, stale-save review, unknown-result retry and peer-safe history remain on their existing implementation paths. The keyboard behavior change is deliberate: canvas editing shortcuts require world focus rather than firing through focused controls. Text editing retains its existing native undo behavior.

## Run

Use the repository's Node 24+ setup, `npm ci` and `npm run build`. No extra package dependencies.

```sh
npm run check
node --test --test-reporter=spec tests/editor-geometry.test.mjs tests/editor-collaboration.test.mjs tests/editor-area-collaboration.test.mjs tests/editor-image-policy.test.mjs tests/personal-editor-policy.test.mjs
node tests/editor-polish-feedback.browser.mjs
node tests/editor-polish-experience.full.mjs
node tests/editor-polish-regression.mjs editor-transactions.browser.mjs terrain-editor.browser.mjs editor-image.browser.mjs editor-collaboration.browser.mjs editor-collaboration.full.mjs editor-collaboration-restart.full.mjs editor-area-collaboration.full.mjs editor-compact.full.mjs
node tests/editor-polish-record.mjs
```

The regression runner copies the existing suites temporarily under a uniquely prefixed filename and redirects their evidence output. It does not edit them. Run browser suites serially. The recording command needs local `ffmpeg` and captures actual Chromium CDP frames with their capture timing.

## Limits

Chromium software WebGL and browser touch emulation at DPR2 only, not physical phones or phone-FPS evidence. Local synthetic accounts, SQLite/HTTP/SSE and injected local transport interruptions only. No production, providers, credentials, paid services or external deployment were used. Screen-reader output and physical touch keyboards were not tested. This is a focused editor slice, not a shell or renderer redesign.

Before evidence is from the exact base. The original direct-editor walkthrough passed before edits; targeted before tests reproduced focused-button ArrowRight moving the selected object at desktop, 320×568 and 568×320. After evidence uses the changed editor. Consult `evidence/editor-polish-results.json` for actual suite outcomes and bundle hashes, including the intermediate compact-layout failure and its correction.

## Results

| Check | Actual result |
| --- | --- |
| Source syntax | 332 files passed |
| Geometry, collaboration, area, image and scoped-policy unit checks | 42 passed, 0 failed, 0 skipped |
| Final editor transactions / terrain / collaboration model | 10 / 14 / 47 checks passed |
| Final immutable-image browser suite | Exit 0, including free/grid modes, pinned versions, inspector actions and compact reachability |
| Final focused polish cases | 6 passed |
| Final compact native suite | 9 passed: 568×320 mouse, 568×320 touch and 320×568 touch |
| New experience suite | All 7 assertions/journeys passed; two ordinary editors; no page exceptions |
| Earlier-candidate native collaboration / restart / areas | 5 / 3 / 9 passed; exact boundary and supplied bundle hashes in evidence JSON |
| Interaction recording | 21 actual captured frames over 6.69 seconds, encoded with original capture timing |

Final application-source SHA-256 values and per-run details are in the evidence JSON. The native collaboration/restart tests preceded the final presentation refinements; they are not presented as a fresh run of every suite on the final bundle. The save/transport/collaboration paths themselves were not edited.

Screenshots: `evidence/editor-polish-before/` and `evidence/editor-polish-after/`, with matching desktop, portrait and landscape selection/rejection views. The short recording is `evidence/editor-polish-recording/editor-polish-interaction.mp4`. The shell's pre-existing narrow-header crowding and glyph fallbacks are visible in the evidence and remain outside this slice.

Execution environment: local dependencies were reused without editing package files. The original browser runs used an isolated temporary directory for the packaged Chromium/SwiftShader runtime. On a normal checkout, the repository browser launcher can use its default temporary directory. No runtime binaries are included in the deliverable.
