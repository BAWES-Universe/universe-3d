# Available-width controls

The local baseline at `be6d136961010f986fde7c1ddaf13b66e164621a` reproduced a real obstruction: with a 60vw room iframe at 1440×950, its surface intercepted native clicks on Build, Express, Quick actions and Shortcuts. The existing off-axis picking fixture also needed keyboard activation because Build's help row covered its content opener.

## Policy

- Measure transformed embedded/resident side surfaces into a CSS control lane, without resizing the canvas or changing camera/picking code
- Bound desktop embedded content so at least 360 CSS pixels remain for controls; narrow portrait and short landscape content deliberately use a full-screen sheet
- Keep the complete dock, Build toolbelt and compact header actions natively scrollable; Tab brings focused buttons into view and touch keeps full-size targets
- Place chat within the available lane, with separate scroll rows for camera and room-content actions
- Keep camera buttons on one horizontal row. When keyboard focus leaves a button partly clipped, reveal it by the minimum horizontal scroll within that row only; do not move focus or scroll the document
- Keep Build's content opener clear of keyboard help, constrain its tray/inspector, and leave the explicit Done/Return controls reachable
- Let centered app sheets appear above ordinary side content; the iframe sandbox and provider permissions are unchanged
- Retain the source ink/rounded tokens, exact source SVGs, and complete 2:1 logo/tagline. Compact Build hides its redundant room heading

The policy is implemented by `src/hud-availability.js` and `src/hud-availability.css`, plus ordinary responsive embedded-panel CSS. It never dispatches input, changes focus, pans, zooms, writes world state, or changes the Babylon viewport.

## Verification

Run `npm run test:browser:hud` for the actual-game HUD, medium-width header and coexisting-content history checks. Run `npm run test:browser:framing` separately for camera framing, DPR2 picking and resident editing regressions. The serial suites use local intercepted content, native mouse/keyboard, native CDP IME/touch input, element hit testing and document-overflow assertions.

The HUD checks verify same-row camera bounds, no vertical camera overflow, full desktop visibility before camera input, and native Tab/wheel reachability in a narrow lane without test-side scrolling. Focus reveal must leave camera, world position and document scroll unchanged. They also cover desktop chat+embed+Express, requested 90vw content at 1440 and 1024 pixels, enlarged control text, portrait, landscape and touch scrolling. Medium-width header checks exercise actual 40vw content at 1440 and 1280 pixels, including native Bots/Manage activation, separate brand/title/action bounds and enlarged action labels. Decorative room headings never intercept input.

Six pure geometry cases cover the available control lane. A focused unit case verifies one-time binding, minimal bounded row scrolling, and ignoring pointer focus or non-horizontal layout. Existing framing and DPR2 picking regressions preserve the full canvas, projection math and alpha-aware selection. The picking fixture uses native mouse/touch activation for the formerly covered content opener. The 390px touch regression caught an interaction with old phone inline-size containment; intrinsic dock sizing now removes that containment so the scroll viewport cannot collapse to its padding.

Coexisting content and foreground panels use the history model described in [CONTENT-HISTORY.md](CONTENT-HISTORY.md). The combined HUD CI group requires native Chat/Places Close buttons instead of relying on a keyboard route around an obstruction. Layout-only scenario reloads isolate geometry assertions; the history suite separately verifies iframe identity, typed form state, browser traversal and fresh authorization without such resets.

See [DEVELOPMENT-STATUS.md](DEVELOPMENT-STATUS.md) for the exact integrated verification boundary. These are local Chromium software-WebGL and emulated-touch tests, not physical-phone, external-provider embedding or deployment certification.
