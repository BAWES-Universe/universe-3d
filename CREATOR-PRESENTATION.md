# Character creator presentation

The character creator keeps a blurred snapshot of the world behind its live 3D preview. The world renderer skips animation, camera/framing work, label placement and scene drawing while that preview is open. The application continues its normal updates: presence, chat, media-policy checks, room changes and revocation cleanup are not paused.

On close, the next world frame uses current actor positions, applies any deferred canvas resize, restores labels before measuring them, and uses zero visual delta once. Time spent editing is never replayed as a movement or animation jump. World projection and picking are unavailable while suppressed, preventing hidden-world interaction. Disposal restores the label root and clears presentation resources.

The retained backdrop can stretch during a window resize until the creator closes. This trades live world movement behind a modal for fewer draws; it is not a claim of zero total GPU work. Texture/resource synchronization can still occur, and the creator itself remains animated. Existing DPR/resolution policy is unchanged.

The community table deck and quiet terrace now sit at 0.034 m and 0.038 m respectively; paths/portal paving remain at 0.030 m and custom image floors at 0.050 m. Only decorative Y layers change. Horizontal footprints, collision rules and solid props are unchanged.

## Evidence

`npm run test:browser:presentation` exercises the actual game: edit/cancel/save/reload, current remote pose/chat after pause, retained player state, resize, preview disposal, browser Back/Forward, Escape and access revocation. Read-only renderer/creator frame counters show no new world draws while preview frames and presence/media HTTP requests continue. Integrated CPU tests and the full framing/DPR2 alpha-picking/resident suite pass as well.

These are local software-WebGL lifecycle checks, not a physical-phone, FPS, battery, media-packet or production-load benchmark. Source and test results are scoped to the exact published commit.
