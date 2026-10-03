# Asset provenance and distribution boundaries

This repository does not apply a new blanket license to third-party assets or BAWES branding. No project-wide open-source license has been chosen.

## Included assets

- `public/assets/bawes-logo.png`: unchanged BAWES brand image from [BAWES-Universe/bawes-new-website](https://github.com/BAWES-Universe/bawes-new-website/blob/8e7cf905dc39b5a249577b3b09a683cd5b1ba48c/public/images/bawes-logo.png), commit `8e7cf905dc39b5a249577b3b09a683cd5b1ba48c`, Git blob `44efab2e2f0be0d3e1ed5436b80c958a05537a47`. Brand rights remain with their respective owner; inclusion is not a trademark or general reuse grant.
- `space-grotesk.ttf`: Space Grotesk Bold, Copyright 2020 The Space Grotesk Project Authors. The embedded name table identifies the [upstream project](https://github.com/floriankarsten/space-grotesk). SIL Open Font License 1.1, reproduced in `public/assets/licenses/space-grotesk-OFL.txt`.
- `roboto.woff2`: unchanged Latin 400 normal font from `@fontsource/roboto` 4.5.8 (font source v30). Copyright 2011 Google Inc. All Rights Reserved. SHA-256 `f6734f8177112c0839b961f96d813fcb189d81b60e96c33278c1983b6f419615`. The font metadata identifies Apache License 2.0; the upstream [Roboto 2 license](https://github.com/googlefonts/roboto-2/blob/main/LICENSE) is reproduced in `public/assets/licenses/roboto-Apache-2.0.txt`. Package-wrapper licensing is not used to relicense font bytes.
- `pixel.woff2`: unchanged Latin 400 normal font from `@fontsource/press-start-2p` 4.5.11. Copyright 2012 The Press Start 2P Project Authors, with Reserved Font Name "Press Start 2P". SHA-256 `965686370a3ddd3956adc0cf955459e32492373fd552ca94338cf8e2a2c932ea`. SIL Open Font License 1.1, reproduced in `public/assets/licenses/press-start-2p-OFL.txt`.
- `chime.wav`: original generated three-tone C-major sound for the opt-in local audio example; no external recording.
- Architecture, furniture and room layouts: original procedural geometry and layouts in `src/renderer.js` and `src/worlds.js`. No Core Keeper, Habbo, Palia, CrossCode or WorkAdventure tileset art is included.

Dependency versions and their published licenses are recorded in `package-lock.json`. Dependencies are installed from npm and not vendored here.

## Original native 3D character and environment artwork

The current renderer, onboarding, People portraits and character creator use original procedural 3D geometry, materials and animation in `src/avatar-rig.js`, `src/avatar-creator.js`, `src/environment-materials.js` and `src/scene-layout.js`. No legacy Woka sprite download is needed. Appearance definitions are in `src/avatar-spec.js`; this free original catalog does not claim to reproduce or transfer upstream paid/custom-avatar entitlements.

The former Pipoya sprite PNGs are excluded from this repository and are no longer requested by the runtime. Prior upstream inclusion established provenance, not redistribution permission. No Core Keeper, Habbo or third-party game textures or character meshes are copied.

- `public/assets/bawes-universe-logo.png`: the complete, unmodified BAWES Universe logo from `BAWES-Universe/workadventure-universe-admin`, `public/assets/logo-300x150.png`, commit `c2053a56fa0cd89001cdb1b83c469281a672a9ef`, blob `b129b96e0d9c618fa96cf15a237d3f59803f27a8` (byte identity verified in the supplied design audit). SHA-256 `5e5b3f65d80bd38972cc56f94032848454784d76cb8be5cb31fe4b86d4242302`. Rendered at its original 2:1 aspect ratio. Brand rights remain with the owner.

Typography keeps role-specific source distinctions: Space Grotesk headings, native-game Roboto UI and Press Start 2P name labels. The website's Inter role is not presented as the legacy game UI font. Ink panels follow the audited proposed `#14121E`/violet roles; this standalone implementation does not claim those proposals were deployed upstream.

## Current-source chrome port (October 2026)

`public/assets/icons/manifest.json` records exact source URLs and commits for the nine audited native/Orbit SVGs and tagged source-family additions. The native source paths retain their 1.5px or 2px strokes; added Tabler glyphs come from the same game-locked `@iconify-json/tabler` 1.2.23 package (Tabler 3.35.0, MIT). Earth and DoorOpen retain Lucide 0.468.0 geometry (ISC); their source-family role matches Orbit, without claiming this tag is Orbit's locked version. Licenses are included in `public/assets/licenses/tabler-MIT.txt` and `lucide-ISC.txt`. `src/universe-icons.js` only adds decorative SVG wrappers/classes, with accessible labels kept on controls.

`public/assets/inter-variable.ttf` is the unmodified verified Inter 4.001 variable font from the supplied workspace, with font metadata identifying upstream commit `66647c0bb`, weight 100–900 and optical-size 14–32. SHA-256 `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031`. Its [matching upstream SIL OFL](https://github.com/rsms/inter/blob/66647c0bb/LICENSE.txt) is reproduced in `public/assets/licenses/Inter-OFL.txt`. This asset is scoped to the Orbit-like Places body, not a global native-game font replacement. The existing static Space Grotesk Bold face is now declared at its actual weight 700.

`public/universe-tokens.css` separates native persistent flat ink from raised transient surfaces, and preserves Orbit's universe/world/room/star/people color meanings. Active controls use the game #598 violet–blue gradient; a separate inset white focus outline fixes the audited active-state focus-ring defect. This source port does not assert a live upstream rollout.

## User-created room images

The custom library accepts room-authorized runtime PNG uploads stored in the separate SQLite data volume. No actual uploaded user images are included in source exports. Original synthetic checker/frame/color fixtures are generated by `fixtures/png-fixtures.mjs` only for tests. Asset definitions, pinned versions and placed instances are separate records; uploading a file does not establish license ownership, a sale entitlement or permission to redistribute it. Optional provenance text is an author claim, not a verified license.

The participant-controls SVG geometry in `src/proximity-controls-ui.js` preserves the native Follow, Lock and LockOpen icons at game commit `bae18306bdfa63e58cd4124b1a3b5b290b61c286`. Exact source paths and blob IDs are recorded in `docs/proximity-controls-client.md`; existing Tabler license notices apply. No new third-party raster assets are introduced.
