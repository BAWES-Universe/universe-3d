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
