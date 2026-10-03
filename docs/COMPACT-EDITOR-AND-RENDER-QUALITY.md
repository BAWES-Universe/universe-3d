# Compact building and render quality

The compact editor now presents reachable editing sheets and core actions on
small screens. Rendering uses a bounded CSS-resolution policy independent of
device pixel ratio, and the character creator supports enlarged text in a
scrollable sheet. The earlier behavior was reproduced against public
`92fc8b6` before these changes.

## Compact editor

The editor follows the width of its available world/HUD region, including an
open side window. Compact layouts show a single active sheet. Room, Save and
Done remain at the top; contextual Rotate stays in the main tool row. A labeled
More control holds secondary actions, with Undo/Redo first. Buttons keep their
existing event handlers and permission state when moved between layouts.

Short landscape uses a side sheet with a stable close header and one scrolling
body. It preserves an exposed world region for pointer/touch placement. The
observed inspector body grows from 24px to 161px at 568×320 and is 149px at 320×568.
Opening Room dismisses the competing palette. Water no longer hit-tests to
Done. Save feedback remains an announced status but cannot intercept the next
edit. Copy/Undo/Redo use existing Universe SVGs; other catalog art/glyphs are
still separate visual work. Main compact targets remain at least 44px wide and
48px high. Desktop controls and keyboard shortcuts retain their behavior.

Native tests cover Room/environment changes and scrolling, Water selection,
painting, placement, visible Rotate, More/Undo/Redo, selected-object rotation,
Save and reload with real local authentication/persistence. Pointer and
emulated DPR2 touch run at 568×320; portrait touch runs at 320×568. Existing image,
terrain, HUD and DPR picking fixtures must use the same visible controls rather
than bypassing the new compact menu or asserting its retired two-row layout.

## Render resolution

The old scaling formula reduced the render buffer as device pixel ratio grew.
At 320×568 CSS pixels, measured world buffers were 320×568 at DPR1, 240×426 at DPR2
and 160×284 at DPR3. World and creator now target one render pixel per CSS pixel,
independent of DPR. There is no supersampling or new quality setting.

Explicit fill budgets cap the world at 2,073,600 pixels and the creator preview
at 262,144 pixels. Larger surfaces downsample proportionally. An actual 3840×2160
CSS resize produces 1920×1080 on resume. A world paused behind the creator keeps
its old framebuffer until it can draw again; returning to mobile restores 1:1
CSS resolution. CSS-based picking and transparent-image selection retain
their own native pointer/touch tests.

This deliberately increases small-screen pixel work by 1.78× at DPR2 and 4× at DPR3
versus the defective baseline. These are render-pixel counts, not measured GPU
milliseconds, memory use or physical-device frame rates. The caps bound fill
work, not every rendering cost; hardware performance still needs measurement.

## Character text and touch

Creator text uses scalable rem units. The small-screen dialog scrolls as a
complete sheet, controls wrap, and Save/Cancel remain accessible. Vertical
preview swipes scroll the sheet while horizontal gestures retain orbit control.
Opening the creator resets its scroll to the heading; closing still disposes
the preview renderer and restores world presentation.

The explicit root-font 200% fixture changes the root from 14px to 32px and its
heading from 23px to 52.57px. Native emulated touch reaches Hair, Outfit, Shoes,
Extras, Save and Cancel without horizontal overflow. Saved choices persist and
Cancel leaves the saved appearance intact. This is a CSS stress fixture, not
OS Dynamic Type, physical virtual-keyboard or accessibility certification.

## Reproduce

```sh
npm run build
node --test tests/render-resolution.test.mjs
node tests/editor-compact.full.mjs
node tests/editor-toolbar.browser.mjs
node tests/picking-dpr.browser.mjs
node tests/render-quality.browser.mjs
node tests/creator-render.actual-game.mjs
```

The browser runner registers compact editing in the images group and render
quality in the presentation group. Run software-WebGL suites serially.
Evidence is written to `evidence/editor-compact/`, `evidence/render-quality/`
and the corresponding existing suite directories. A registered test is not
itself a passing result; check the relevant workflow run for its outcome.
