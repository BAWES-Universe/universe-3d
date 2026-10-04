# Integrated polish candidate

Base: `bc715ff6ccc0c3d2537e4c003cb4a7bb82745a34`, tree `59799410195058ff90a5b0e11ebd1d9103a489df`.
Branch: `external/polish-integration`. Local synthetic-data work only.

## Preserved improvements

- Editor: sheet-local selection/rejection feedback, explicit snap feedback, history descriptions/counts, focus ownership for editing controls, larger inspector actions and canvas focus after closing sheets.
- World: warmer material/light balance, soft object/avatar contacts, depth-tested selection corners, reduced-motion/Build decorative pauses, renderer label cleanup.
- Shell: real More navigation, five compact primary actions, explicit Build/Done state, stable desktop dock, compact Chat, menu focus/gesture isolation, iframe state preservation.

The supplied source changes were disjoint. The original kit checksums and exact original Git commit/tree were verified before applying them. Author reports under the other named integration documents are historical source evidence, not final combined acceptance.

## Integration repair

The shell implementation excluded desktop embedded panels from `createHudAvailability`. This fixed the dock but also stopped the header, inspector and Connect panel from respecting occupied space. In the combined app, native pointer targeting hit the iframe instead of the inspector Close control, and content-window buttons instead of Manage/Share. The existing arrival reconnect test also failed to reach its editor field through the iframe.

Keep the original measured available-width policy in `src/hud-availability.js`. Scope the fixed desktop dock to CSS, with corresponding Quick actions/Help positions, Chat width and the maximize stacking override in `src/hud-availability.css`. Existing renderer framing remains independent. The new `polish-integration-side-content.mjs` test asserts the header/inspector remain hit-testable and the desktop dock geometry does not move.

The full content-history and panel-framing suites then caught an overly broad Chat selector in the integration repair. Scope left-side Chat to an actually open embedded panel; after it closes, Chat returns to the right and camera controls remain reachable. The side-content test explicitly checks that transition.

The full HUD check also reproduced a compact Quests shortcut covering the area-content opener at 390px. Quests remains reachable through More. Hide its duplicate compact shortcut and position portrait area actions below the camera controls. The existing native touch check passes at 390×844, 844×390 and 1100×850, including area actions, Build, Express and Return to world.

The DPR picking journey also reproduced portrait Build's header covering the visible zoom row. In portrait Build, place the camera row below the editor header. Compact selection checks wait for an actual rendered, settled frame before projecting the target after closing a sheet; native selection and exact saved-scene assertions remain unchanged.

The compact editor trace reproduced a real touch tap-through: pointer-down on the canvas selected the chair, pointer-up still targeted the canvas, then the browser-generated click targeted the newly opened inspector Close button. Track whether the touch began inside the editor and reject a retargeted touch click that began outside it. Direct editor taps and keyboard activation remain enabled, and the listeners are removed on destroy. The native compact journey retains this regression and logs the event sequence.

The Nearby chat test with doubled text reproduced a short-landscape scrolling regression. The shell's new inner-panel overflow rule overrode Nearby's existing outer-shell scrolling policy, trapping native touch before the composer could be reached. Exclude Nearby from that shell override, preserving the existing social behavior and assertions.

## Test maintenance

The old HUD/image browser checks required a scrolling navigation dock and a directly visible compact You/Express button. Their native interaction checks now exercise the fixed dock and the actual More routes. They still assert control reachability, target dimensions, visible keyboard focus, window behavior and content retention. No assertions about permissions, saved data, image pins, collisions or recovery were removed.

The terrain touch journey likewise reaches Reset camera through its compact More menu entry. The old direct camera shortcut is intentionally hidden by the supplied shell; the native touch/camera cancellation and subsequent terrain-placement assertions remain intact.

A review of the remaining registered journeys found the same retired compact targets in avatar live/render-quality, Express and personal spaces. Their native compact entry steps now use More → You, Express or Quick actions. Their profile persistence, renderer budgets, input ownership, bounded editing and account assertions are unchanged.

Camera-walkthrough and DPR picking likewise use More for compact orbit/tilt. Editor-direct explicitly focuses the canvas before selection shortcuts, respecting the new focused-control ownership rule. The bot-editor module fixture failed identically on the exact base: an error selector matched a hidden placeholder as well as the visible alert. It now targets the visible alert and asserts the current, unchanged unconnected-provider copy. No bot application code changed.

The supplied editor experience harness gives its second browser page an explicit navigation/ready budget to account for software WebGL. The original 30-second navigation timeout is retained as an unsuccessful preliminary run, not counted as a pass.

Run `npm run build`, the repository CPU/API checks and every group registered by `scripts/test-browser.mjs`. `node tests/polish-integration-suite.mjs` runs all registered browser files serially, once each, without stopping after the first failed file. The final delivery README and logs are authoritative for which checks passed or failed.

## Boundaries

No server, protocol/schema, package, CI, saved-world data, image physical-size feature, signup/deployment, media effects or asset-workshop changes. No push, PR, deployment or production use. Upstream PR source pins are retained from the supplied shell report; this integration does not establish their current merge/deployment status.

Local Chromium uses software WebGL. Portrait/landscape and touch checks are browser emulation. Embedded forms are locally intercepted synthetic content. No physical-phone, hardware FPS, hosted-media or complete-parity certification is made. The browser-verification skill's agent-browser CLI was unavailable; the repository's installed Playwright/Chromium harness was used.
