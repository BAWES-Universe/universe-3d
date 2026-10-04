# Guided Places creation

Make a place creates one Universe, one World, and one Room using the entered name and Privacy choice. The original actor owns the hierarchy; public visitors do not receive world membership or editing rights. Advanced creation and management use the existing server capabilities.

The flow writes an account-scoped, per-tab receipt before each POST. An interrupted response retries the identical operation and payload. Only a definite `SLUG_TAKEN` response permits replacing the pending slug and operation ID. The actor is checked before every attempt, after progress callbacks, and after both successful and rejected responses. An account change preserves the original receipt and stops further requests.

Creation remains three separate server commits. Confirmed parents remain if a later step fails. A retained receipt supports reload and retry in the same tab; clearing tab storage or moving to another device is outside this recovery guarantee. This is not a whole-hierarchy transaction or a rollback mechanism.

Places only recovers focus while it owns the foreground. A visible external modal, including Quick actions, keeps ownership during keyboard release, catalog refresh, DOM mutation, and resize. Narrow and short viewports keep creation actions in the normal scroll flow so they cannot cover Privacy.

## Regression checks

Run after `npm run build`:

- `node --test tests/places-creation-flow.test.mjs tests/hierarchy*.test.mjs`
- `node tests/places.live.mjs` (the canonical management and authority fixture)
- `node tests/places-creation-focus.browser.mjs`
- `node tests/places-foreground.full.mjs`
- `node tests/places-creation.full.mjs`

The three new browser regressions run together with `npm run test:browser -- placescreation` and are registered as the `placescreation` CI group. The existing canonical management fixture remains in the `authoring` group.

Serialize browser runs on hosts using software WebGL. The full-game checks use the real bundled shell, SQLite, HTTP, native Chromium keyboard input and emulated touch. Touch emulation does not certify physical devices, OS virtual keyboards, Safari, Firefox, or screen readers. The negative baseline-focus reproduction is not a passing regression test.
