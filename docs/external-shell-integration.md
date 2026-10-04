# Shell/navigation polish

Base: `BAWES-Universe/universe-3d` at `bc715ff6ccc0c3d2537e4c003cb4a7bb82745a34`.
Local branch: `external/shell-polish`. No push, PR, deployment or production access.

## Scope and integration

Four application files changed:

- `src/main.js`: a transient More dialog using existing action owners, focus/keyboard ownership, visible Build/Done and `aria-pressed`, reconnect/travel/blur cleanup, and suppression of irrelevant framing notices when the world is intentionally covered.
- `public/style.css`: the More dialog's existing Universe token styling, focus and reduced-motion behavior; status text cannot intercept pointer input.
- `src/hud-availability.js`: at desktop widths (1024px+), embedded content no longer shifts the control lane. Resident authoring retains its existing lane contract. Renderer projection/framing remains independent.
- `src/hud-availability.css`: stable desktop dock, left-side Chat opposite right-side content, with side content above the bottom navigation lane; explicit maximize still covers/inerts the dock. Compact navigation has five full-size primary actions. Short-landscape Chat is a full sheet with a reachable composer; the editor retains its existing tray and close behavior.

No editor, renderer, media, server, schema, package, CI, saved-world or `modules/asset-workshop/` changes. The other five authorized application files were inspected and left unchanged. No `AGENTS.md` was found in the checkout; README, BRAND-PORT, CONTENT-WINDOWS, existing input/window tests and implementation contracts were read first.

More calls the existing owners for Connect, Express, You, native character creation, Quests, personal spaces, Custom images, residents, Manage, Share, camera actions, Quick actions and shortcuts. Resident availability follows the existing capability; ordinary users retain Manage's existing directory/access UI and can still inspect their available actions. Build retains the existing permission gate and dirty indicator. More adds no provider or backend API.

Compact means width <=700px or height <=540px. Explore, Chat, People, Build and More fit without horizontal scrolling at 320px. The three compact secondary dock triggers stay mounted and are reachable through named More rows. Camera zoom and follow remain directly visible; More exposes labelled orbit, tilt, pan and reset controls. At short landscape, Chat and Build use their own close controls while the covered dock is hidden. This avoids placing shell buttons over the editor's furniture tray.

The More dialog is transient: no new history entry, storage key or persistence contract. Escape, outside click, blur, room travel and browser history dismiss it. Opening clears existing world/editor pointer gestures and held movement; it never resumes a held key automatically. Tab stays inside the menu, and Escape returns visible focus to More. Closing compact You returns to More instead of its hidden desktop trigger. Connect now also stops an in-flight walk on explicit opening.

Iframe and draft lifetime remain with the existing modules. The shell changes only presentation height/layers for side content. It never reparents a frame, assigns its URL or reloads a tab. Explicit Return to world/Close still disposes content. No editor/media integration hook is required for this slice. Future integration should preserve the existing `onWindowChange`/`windowState()`/`setWindowForeground()` contract and native owner callbacks; do not replace modules or wrap them in a second panel host.

## Source comparison

All inspected revisions are in `external-shell-source-pins.json`.

| Reference | Inspected head | Observed source state | Adaptation |
| --- | --- | --- | --- |
| [#613](https://github.com/BAWES-Universe/workadventure-universe/pull/613) | `948e8f1f71912d8ea19ac105b85e17c1446d3bc2` | Merged to its batch branch | Stable chrome, toggle semantics, keyboard-only focus. Its old Keep-bar preference is superseded. |
| [#620](https://github.com/BAWES-Universe/workadventure-universe/pull/620) | `662e8b72e015f601a65b263ed4f13370668422cd` | Merged to its batch branch | One desktop layout, no preference/toggle. The 3D app's bar is at the bottom, so side content leaves a bottom navigation lane. Maximize covers it. |
| [#625](https://github.com/BAWES-Universe/workadventure-universe/pull/625) | `e2ed189d6c2985a7717663bf51889f9ec1643f54` | Open proposal at inspection | Reviewed independent discovery, labelled controls, tap/drag cleanup and transition guards. No zoom-triggered 2D Look Around mode or editor-tool coupling was ported into 3D. |

Merged source is not proof of release or deployment. No production behavior was inspected or asserted. PR bodies, source diffs and relevant discussion were read; #625's reported tool-restoration concern was disputed by its author and was not treated as a confirmed defect or copied. Its scene-transition guard was present at the pinned head.

The existing Roboto/Space/Inter roles, logo, colors, source SVG geometry and asset manifest remain unchanged. More uses the existing ChevronUp disclosure glyph. No new font, asset or generic color theme.

## Verification and evidence

Use Node 24+. Build first, run software-WebGL suites serially:

```sh
npm ci
npm run check
node --test --test-concurrency=2 tests/*.test.mjs
npm run build
node tests/external-shell-journeys.mjs
node tests/external-shell-window-regression.mjs
node tests/external-shell-menu-input.mjs
SHELL_PHASE=after node tests/external-shell-baseline.mjs
node tests/external-shell-record.mjs
```

- CPU/API suite: 1,649 tests, 1,648 pass, one pre-existing skip, zero failures (concurrency capped at two for a complete recorded run).
- New actual-app journeys: 12 checks passed; desktop 1440x900, portrait 320x568, landscape 568x320; synthetic registered owner and ordinary visitor. Walk/held-key cancellation, menu focus/Tab/Escape, Chat/People/draft, Build, character save, room travel, real SSE socket cut/reconnect, embedded drag-resize/maximize/restore/exact-node and draft retention, intentional close, compact action reachability, UI pointer isolation, reduced motion and overflow checks.
- Window regression: all 10 cases passed. `external-shell-window-regression.mjs` is the exact base's `content-window.full.mjs` with only its evidence filename prefix changed. It exercises the existing window/history/iframe/covered-chat/unread/focus contracts, native CDP touch resize/cancel, width thresholds and keyboard dismissal.
- Baseline and after screenshots run the actual seeded world, not a mock shell. They include arrival, Chat, and owner Build. The supplied evidence includes dedicated More, window and short-landscape Chat screenshots.
- Menu input probe covers native Enter/Space activation and focus restoration, editor-key isolation and a CDP two-finger gesture over More. Browser pinch zoom is deliberately permitted; camera invariance is separate from browser visual scale.
- Recording (9.28 seconds, 143 captured frames) uses actual DOM input and CDP frames at their original timestamps, encoded with ffmpeg. No inserted UI or injected application state.

Generated output lives under `evidence/external-shell/` and `evidence/external-shell-window-*`; it is included in the delivery evidence archive, not the source commit. See JSON/logs for exact checks, bundle hashes and capture scope.

### Honest limits

Chromium uses SwiftShader software WebGL. Touch sizes and gestures are emulated; blur is a synthetic lifecycle event. This does not certify physical phones, iOS keyboard/viewport behavior, hardware FPS or player capacity. The real local SSE connection is interrupted; no external network handover was tested. Embedded HTTPS form content is intercepted synthetic bytes, not a real third-party provider. No live messages, camera/microphone capture, paid services, external credentials or production systems were used. Existing media-delivery acceptance limits remain unchanged.

The browser verification CLI could not start its daemon twice; the repository's native Playwright/Chromium harness was used instead. Early test-selector mistakes and a fixed icon-registry mismatch are not counted as passes. Full final results are supplied separately.
