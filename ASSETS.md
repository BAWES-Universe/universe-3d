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

## Excluded legacy Woka sprite sheets

The six legacy Woka images are Pipoya artwork. The [publisher's terms](https://pipoya.itch.io/pipoya-free-rpg-character-sprites-32x32), checked on 2026-10-02, permit use in games but restrict asset redistribution. No separate permission to publish raw PNGs in this repository has been established, so they are excluded from Git and ignored by `.gitignore`. They are not embedded in a committed build or test screenshot.

The v0.3 renderer and picker still refer to these optional local files. Without them, source compilation and the local server work, but avatar artwork is blank or untextured. This checkout is therefore an incomplete visual checkpoint. A separately developed native-3D-avatar implementation is intended to remove this dependency; that work is not present in this version.

For a private local review, obtain the sprites directly from the publisher under applicable terms. Do not commit or redistribute them. The existing legacy file mapping is:

| Local filename | Publisher pack filename |
| --- | --- |
| `public/assets/woka-0.png` | `Male 01-1.png` |
| `public/assets/woka-1.png` | `Female 01-1.png` |
| `public/assets/woka-2.png` | `Male 09-1.png` |
| `public/assets/woka-3.png` | `Female 09-1.png` |
| `public/assets/woka-4.png` | `Teacher male 02.png` |
| `public/assets/woka-5.png` | `Teacher fmale 02.png` |

The legacy files were matched by Git blob identity to `play/public/resources/characters/pipoya/` in `BAWES-Universe/workadventure-universe` at commit `bae18306bdfa63e58cd4124b1a3b5b290b61c286`. Their presence upstream is provenance, not independent redistribution permission.

Rebuild after adding any authorized local-only visual assets. Do not publish screenshots or builds containing excluded assets without establishing the necessary distribution rights.
