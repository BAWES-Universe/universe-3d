# Current Universe chrome port

This development checkpoint ports game PR **598**, commit `966d723d1a5d7ab31debd1fe08d68b5878017e80`, stacked on 596, together with Orbit's audited semantic kind roles. These were source proposals, not evidence of an upstream live rollout. The earlier quality checkpoint remains available in Git history.

## Integration API

- `public/style.css` imports `/universe-tokens.css`; all existing feature CSS consumes that shared contract
- `src/universe-icons.js`: `icon(name, className = '')` returns a decorative inline SVG string. `ICON_NAMES` lists the 47 supported names. Keep the actual button's IDs, accessible labels, state attributes and handlers
- Exact audited names: MessageCircle, Users, Emoji, Settings, Orbit, MicOn, CamOn, Share, Planet
- Extra source-family controls: Tools, Plus, Minus, RotateLeft, RotateRight, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Move, Focus, Home, Close, Search, Send, Star, Check, ArrowRight, ArrowLeft, Undo, Redo, Pencil, Trash, Copy, Save, Volume, VolumeOff, MicOff, CamOff, Help, Command, Hand, Play, Pause, ExternalLink, Pointer, Earth, DoorOpen
- Add `data-kind="universe|world|room|star|people|tools"` to relevant Places rows, chips and breadcrumbs. Existing `.places-tree-world` and `.places-tree-room` receive their own source colors too
- Surface tokens: `--u-surface-flat`, `--u-surface-raised`, `--u-surface-joined`, `--u-shadow-flat`, `--u-shadow-raised`, `--u-edge`, `--u-backdrop`
- State tokens: `--u-primary`, `--u-primary-hover`, `--u-primary-pressed`, `--u-muted-coral`, `--u-muted-coral-hover`, `--u-muted-coral-pressed`, `--u-secondary`, `--u-control-hover`, `--u-control-pressed`
- Kind roles: `--kind-{universe,world,room,star,people}` and matching `-solid` colors
- `.u-control` provides a circular neutral control with active/muted variants, fixed state bounds and a separate white focus outline. Glyph utilities are `.u-icon`, `.u-icon-sm`, `.u-icon-lg`

Nine audited SVG asset bytes are copied unchanged. Extra Tabler geometry is extracted from the same game-locked Iconify package version 1.2.23, and Earth/DoorOpen use tagged Lucide geometry. Exact provenance and adaptation notes are in `public/assets/icons/manifest.json`; font and icon licenses are in `ASSETS.md` and `public/assets/licenses/`.

Space Grotesk is correctly declared as static weight 700. Inter 4.001 is scoped to Places; native UI remains Roboto. The full BAWES Universe logo retains SHA-256 `5e5b3f65d80bd38972cc56f94032848454784d76cb8be5cb31fe4b86d4242302`, 2:1 sizing and its separate tagline.

## Verified

- `node tests/brand-chrome.browser.mjs`: 16 CSS/DOM contract checks, desktop plus 320px, 360px and short landscape; 48px coarse targets, no page overflow, stable state bounds, white active/muted focus, native disabled behavior, loaded Space 700, source hierarchy colors and scoped Inter, flat persistent dock, source-style Say
- `node tests/express.browser.mjs`: 19 isolated Express/command-menu browser checks
- `node tests/social.browser.mjs`: 16 browser checks after correcting its stale “updated Woka” expectation to the actual “updated character” copy
- `node tests/bot-editor.browser.mjs`: 16 isolated DOM/protocol checks
- `node tests/personal-areas.browser.mjs`: 18 real-authority API/browser checks
- `node tests/media-browser.mjs`: native permission-negative, SDP and teardown checks; no media delivery success is claimed
- 11 focused Express, command and label-layout unit tests, plus 3 asset/geometry/font-integrity tests
- Every changed CSS file parses through esbuild with no warnings

`evidence/brand-port-*.png` and `evidence/brand-port-results.json` are isolated visual/contract evidence. Their shell uses no WebGL world. See `CHECKPOINT-STATUS.md` for the current integrated build and browser verification boundary; physical-device acceptance remains open.

At 320px the seven 48px dock targets use a horizontally scrollable pill rather than shrink touch areas. At 360px they all fit. The coarse-pointer creator uses a ≥48px touch-target contract; the fine-pointer compact test remains separate.
