# Embedded content windows

This increment adds visual resize and maximize/restore to the existing room-content window. It does not add an Orbit provider, picture-in-picture, social Follow, a desktop toolbar, or a partial “Keep the bar in view” preference.

## Source and deliberate adaptations

The upstream reference is [PR609](https://github.com/BAWES-Universe/workadventure-universe/pull/609), pinned to merge commit `9a68beea975560480c2c4dd3f23aeb50ef6f330b` on its batch branch. This is source evidence, not deployment evidence.

- [Modal.svelte](https://github.com/BAWES-Universe/workadventure-universe/blob/9a68beea975560480c2c4dd3f23aeb50ef6f330b/play/src/front/Components/Modal/Modal.svelte) supplies the game-width ≥1024 maximize gate, visual coverage of underlying windows, same-frame lifetime, Escape-to-close behavior, and reset on destruction
- [ChatSidebar.svelte](https://github.com/BAWES-Universe/workadventure-universe/blob/9a68beea975560480c2c4dd3f23aeb50ef6f330b/play/src/front/Chat/ChatSidebar.svelte) supplies horizontal resizing and the 200px through viewport−50px range. This native right-side window widens by dragging left
- The authored width and existing 360px control-lane cap remain the initial layout. Deliberate manual resizing uses the source range. The existing ≤650px-wide or ≤900px-wide/≤540px-high full-sheet safety layout remains full width, with no unusable resize grip
- The resize target is an actual 48×160px native button outside the panel. Pointer capture unifies mouse/pen/touch. Cancellation, lost capture, window blur, viewport shrink and destruction release the gesture. Viewport shrink clamps remembered tab widths; crossing below the maximize threshold restores compact geometry
- All panel buttons are at least 48px high. The persistent header contains Return to world and desktop Maximize/Restore. The panel scrolls at short heights; long titles are bounded so controls stay reachable

## Behavior

Resize and maximize are presentation only. They never assign the frame URL, detach or reparent a frame, change content history, make authorization requests, request browser fullscreen, or close underlying Chat. Explicit Reload still replaces the selected iframe. Close and Return to world still dispose frames as before; a later history restoration reauthorizes through the existing action runtime.

Each live tab retains its own manual width, iframe, document and input draft. Selecting another tab updates visibility without rebuilding tab buttons or frame holders. Closing the selected tab exits maximize and selects the next remaining tab at its own width; closing a hidden tab leaves the current window geometry intact. Closing all content clears transient widths and maximize state. The five-tab cap and authored Close visibility remain in force.

An Enter gesture that starts on a UI control stays with that control through keyup, even if closing it restores canvas focus or the key is held. A later fresh Enter on the canvas keeps its normal Express binding.

Keyboard: Tab to “Resize content window”; Left widens and Right narrows by 32px (Shift:128px), Home/End select width bounds. Enter or Space starts/finishes a resize session. Escape first cancels an active resize; otherwise it keeps the established content-close behavior, even while maximized. Restore is an explicit control. Host shortcuts are not captured inside cross-origin frame documents.

Embedding keeps the existing HTTPS checks, sandbox and referrer policy. An iframe load event is not proof that a provider allowed embedding. Open in new tab, Reload, timeout guidance and CSP failure guidance remain available; stale callbacks from a replaced frame cannot update its successor.

## Shell behavior

The game measures the actual canvas CSS width. Maximize makes covered game controls and Chat inert while keeping their data mounted. A higher Quick actions, Help, Express, character, Places or authoring dialog temporarily owns foreground focus. Native Tab boundaries surround maximized content, including focus leaving a cross-origin frame; provider keyboard events remain inside that frame. Escape first cancels an active resize, otherwise closes the content window. Visual resize and maximize add no history entries.

Covered Chat counts incoming Room, DM and Nearby messages as unread. Its ongoing Nearby typing stops immediately; restoring the window cannot restart typing without fresh input. Composer, selection and timeline nodes remain mounted. The six existing dock window triggers expose current aria-expanded state with neutral open styling; Build and camera modes retain their distinct enabled state.

## Integration API

`mountEmbeddedPanels` retains its prior API and accepts:

- `getGameWidth: () => number`: actual available game canvas width; viewport width is the default. It is independent of the content/control lane
- `onWindowChange: (state) => void`: a deduplicated visual-state callback with `{open, maximized, foreground, resizing, width, canMaximize, canResize}`. It never invokes the existing open/history callback for a visual-only change

Additional returned methods:

- `windowState()` returns that snapshot
- `setMaximized(boolean)` changes presentation and focuses the window control; returns false when content is closed or the game-width gate fails
- `setForeground(boolean)` yields the maximized window to a higher dialog/palette. A maximized nonforeground root becomes inert; underlying window data stays mounted
- `handleEscape(event)` returns true only when it handles a current foreground content Escape. Call it after higher-layer handlers; it ignores composing/defaultPrevented events
- `refreshLayout()` remeasures after a game-area change that does not resize the browser

The integrated shell inerts covered lower controls while content is open and maximized, and decides which surface owns focus. Leave genuinely higher dialog/palette containers available for their initial focus, then call `setForeground(false)` while they are shown. Re-enable content on their dismissal. This module does not install a global focus trap, capture cross-origin key events, or modify history. Its local key handler protects content controls; shell capture handlers remain responsible for higher Escape priority.

## Verification

Commands (run software-WebGL browser suites serially):

```sh
node --test tests/window-layout.test.mjs tests/embedded-history-dom.test.mjs tests/surface-history.test.mjs tests/action-schema.test.mjs tests/actions.test.mjs
npm run build
npm run test:browser:windows
CONTENT_HISTORY_POINTER_CLOSE=1 node tests/content-history.full.mjs
```

The isolated browser fixture checks actual node/input retention and request counters; unchanged history; native mouse, keyboard and CDP touch/cancel; focus ownership with a higher dialog; source threshold; 320px portrait and landscape/enlarged text; selected/hidden tabs; authored Close; and cleanup. It uses intercepted HTTPS fixture bytes only. Window blur is explicitly a synthetic lifecycle interruption, separately from native touchCancel and viewport resize. Evidence is written to `evidence/content-window-results.json` and the `content-window-maximized.png`, `content-window-320.png`, and `content-window-enlarged.png` screenshots.

The integrated implementation passes 1,110 CPU/API tests with one existing historical skip, 259 source syntax checks, build and package/container-copy checks. Ten native component cases, ten new actual-game cases, all eleven unchanged content-history cases and all five unchanged Express cases pass. The actual-game cases include exact iframe/draft/history retention, covered Chat with a real local SSE message, forward/reverse cross-frame Tab, higher dialogs, source width thresholds, native touch and responsive controls. See Development status for final bundle hashes.

The integrated shell is additionally exercised by `tests/content-window.full.mjs`; final results are recorded in Development status. These checks do not certify physical mobile devices, external providers, or deployment.
