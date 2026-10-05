# Live feedback follow-up

This branch keeps the existing authenticated game, durable rooms, shared editor, invitations and media policy. No host deployment settings or live accounts are changed by this patch.

## Controls and creation

- Space jumps using vertical velocity, gravity and existing solid top-surface landing; T interacts. Build still uses Space to place. Jump is also available as a dedicated touch button.
- Touch movement starts on the right and can be swapped. Movement, camera and Jump have independent pointer ownership. Opening a blocking surface or losing focus cancels movement.
- Chairs, benches and sofas use a room-checked, occupancy-checked seated pose. Standing finds a clear nearby floor point. Waves animate the native avatar and propagate to peers.
- The camera can lower toward horizontal and zoom closer. Existing tables (1.01m), benches (0.625m) and rocks (0.76m) can be used as basic jump platforms; taller solids still block an ordinary jump. Decorative rugs/portals remain walkable, while image collision masks and blocked terrain stay barriers. No new persisted object type or asset-workshop format is introduced.
- Terrain Escape cancels the uncommitted anchor and full held gesture, including any later release; it does not leave a replacement one-cell preview. Earlier committed strokes still use Undo.
- Wall rotation can lock a stroke direction. Nearby quarter-turn walls snap to exact validated touching joints; preview and saved geometry agree. Join feedback is temporary UI, not persisted scene metadata.

## First visit and social UI

- One shared 10–256 character creation policy covers all account creation paths. Confirm-password, control/outer-whitespace rejection and salted scrypt storage remain in place. No email verification or password reset is added.
- Login accepts `identifier` while retaining `email` and `username` compatibility. Rate-limit refusal is visible and retryable.
- Media settings expose microphone/camera devices, supported browser noise/echo constraints, camera quality and a muted local camera preview. Selecting an off device never turns it on; an explicit camera start also shares with currently authorized recipients.
- Media overlays, camera controls, touch controls and area messages use separate responsive lanes and safe-area insets. Area-entry messages stay readable until leaving or dismissing, without forcing a modal or stopping walking.
- Website panels keep sandboxing, explicitly deny camera/microphone/location/display capture, and retain an external-open fallback. A provider can still refuse embedding.
- Quest guidance explains the next step, including leaving before returning when an exploration quest starts inside its target. Markers stay until explicitly hidden; Build guidance stays within the active editor surface. Existing server completion/reward rules remain authoritative.
- Resident editing has explicit Move resident and Add waypoints actions, camera-aligned plan coordinates, numbered route points, Undo/Cancel/Done, and clear save/discard choices. This does not connect an AI provider.

## Verification boundaries

Tests use isolated local accounts and databases, synthetic media tracks, and cloud Chromium with software WebGL and touch emulation. They do not use the owner's camera/microphone or mutate the live service. Browser emulation is not physical iPhone/Safari acceptance or proof of Internet media transport, TURN traversal, production capacity, deployment digest or host security flags. Client positions remain validated reports, not a server-authoritative anti-cheat engine.

New repeatable browser regression group: `node scripts/test-browser.mjs livefeedback`. Existing core, media, terrain, residents, signup and authorization suites continue to apply. The exact published commit's CI is the final remote check; local intermediate artifacts are not a deployment receipt.
