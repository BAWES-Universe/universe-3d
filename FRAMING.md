# Perspective panel framing

Design reference: historical game PR 599, commit `595bf3f0ea1fdc28b19bdc17178c4b0569f452f4`, base `06a50862`. Its measured side-panel geometry informs this Babylon perspective implementation; this reference does not establish an upstream deployment.

Visible chat, resident and embedded side panels now shift the world view toward usable canvas space. The perspective canvas and Babylon viewport remain full size; camera yaw, tilt, distance, avatar size and world positions are preserved. Actual transformed panel and HUD rectangles are measured each frame. Fullscreen mobile sheets and centered modals do not act as side blockers.

The largest available rectangle is selected with separate horizontal and vertical avatar-clearance checks. Insufficient space produces a status and notice rather than cropping or zooming. Changes ease over 500 ms. Follow and explicit resident selection or Focus request framing; native pan or disabling Follow retains the manual target and current projection shift across panel changes. Closing a resident panel, restoring a draft or committing an existing draft does not take camera control.

The DPR conversion and alpha-aware image ray picker are unchanged. Media freshness authority hooks, labels and current styles are preserved. Camera framing changes no permissions or resident-provider behavior.

## Original framing verification

- 410 CPU/API tests, including 14 new framing cases and an exhaustive small-grid geometry oracle
- 14 actual-game framing checks, six DPR2 native mouse/touch picking checks and nine resident-authoring checks
- Syntax, build, package startup/static files and container-file reconstruction passed locally
- Tested main bundle: `e49d5852575146418318c800050ee37ceb15d696682ee1546a6721d3d53aceb8`; CSS is byte-identical to the prior checkpoint

Run `npm run test:browser:framing`. The three serial suites also run as an independent CI group. Remote CI must be checked for the exact source commit. These are local Chromium software-WebGL and emulated-touch results, not physical-device certification.

## Limits

The dock/builder/content occlusion is corrected by the separate available-width policy described in [HUD-AVAILABILITY.md](HUD-AVAILABILITY.md). The picking fixture now opens content with native mouse/touch rather than its former keyboard workaround. `npm run test:browser:hud` exercises the control hit-test/overflow and coexisting-content history scenarios. `npm run test:browser:framing` retains the framing and DPR2 picking regressions. Left-side placement and width transitions still use stated CSS fixtures on real panels. Camera math and input ownership are unchanged.

The alpha-picking fixture freezes a measured nonzero projection shift with the normal Follow control because Build mode closes the area-owned iframe during editing. The test asserts that the shift stays nonzero and unchanged while opaque and transparent image pixels are picked. No provider, deployment or successful audio/video packet claim follows from these tests.
