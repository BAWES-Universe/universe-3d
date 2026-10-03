# Bounded PR609 window-state adaptation

Source: [BAWES-Universe/workadventure-universe PR609](https://github.com/BAWES-Universe/workadventure-universe/pull/609), base `3b45a31145fe7989b0cfed384ae453bb74d82509`, head `49e404e931a03cd556fe918f9a833624aec23e98`, merge `9a68beea975560480c2c4dd3f23aeb50ef6f330b`. The audit records the merge into `claude/project-thread-ioll0t`; these pins do not establish default-branch inclusion or deployment.

The [pinned shared source states](https://github.com/BAWES-Universe/workadventure-universe/blob/9a68beea975560480c2c4dd3f23aeb50ef6f330b/play/src/front/style/style.scss#L971-L992) distinguish an open menu/window from a switched-on mode. This adaptation uses white .14 fill and an inset white .10 edge for explicitly bound native dock window triggers, .18 open hover, .08 closed hover and .12 pointer press. The existing separate white focus outline, button geometry, gradient mode/primary states and coral muted states remain in place.

`createWindowControlStates(bindings)` accepts `{button, controls, isOpen}` records. `controls` is the existing controlled element ID; `isOpen` reads current controller visibility. Creation marks each button with `data-window-control`, sets `aria-controls`, and initializes `aria-expanded=false`. Call the returned function after state initialization and subsequent transitions, or alongside the existing frame sync. It returns a changed-control count and writes only changed visibility. A throwing getter is treated as closed for that poll. It installs no input handlers and never invokes product actions, changes focus, rebuilds controls, or reads camera/world/media state itself.

Bindings in the native game cover these existing controls:

- Chat / People / You: `social` visible and its `dataset.tab` respectively `chat` / `people` / `settings`
- Explore: existing `places` controller visibility
- Connect: existing `media` root visibility
- Express: existing Express tray `isOpen()` state; the `express` container also holds avatar expression bubbles

Build and camera Follow/Pan are real modes and must remain unbound. This is an explicit 3D adaptation of source open-state semantics, not a claim that native Explore or You reproduces the source desktop Explore or profile menu.

Scope excludes the full PR609 bar shell, bar-in-view preference, responsive phone restructuring, Orbit, PiP, social Follow, renderer/camera changes and media capture. Native controls, callbacks, shortcuts and history remain owned by their current controllers.

Focused checks: `node --test tests/window-control-states.test.mjs` and `node tests/window-control-states.browser.mjs`. The latter is an isolated real-shell DOM/CSS fixture with native browser keyboard/pointer interaction, including zero mutation polling, focus, disabled state and stable geometry. Its results do not certify actual-game shortcut/history flows, provider media, WebGL or a live deployment. Run software-WebGL browser checks serially. The actual-game wiring is additionally exercised by `tests/content-window.full.mjs`.
