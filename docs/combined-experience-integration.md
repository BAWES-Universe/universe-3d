# Combined experience integration

This candidate combines independently versioned source changes on baseline `bc715ff6ccc0c3d2537e4c003cb4a7bb82745a34`. The other integration reports in this repository describe their authors' original slices; their results do not automatically certify this combined tree.

## Source inputs

| Input | Exact source |
| --- | --- |
| Editor, world and shell polish | PR #1, `3b24125bc353911ecd410ce8887e3b6cc4216dbc`, tree `1f366b71a8c2cb0e9ee5689c0839e36377df7b13` |
| Admission, preview pipeline and image reader enforcement | `3a30a3937954a91c83df8f9238562fcb40dc89d2`, tree `28e214b1c6d2fd0f667ed8c9687a814cbebbdd2f` |
| Corrected compact conversations | `e24a54e2ca0400f9c8d982a8e566963ac2d5b20c`, selected source tree `36cae23754d4b32d72e4d1080b8cd740164dc778` |
| Corrected Places creation and focus | `b7c6929c3dc2569f40e70a45bf334c6fd5bd56a5`, selected source tree `ddafab13fab5dd30bb10f5edb81064d7b1af5828` |

The compact conversation and Places imports retain their selected source paths. Shared browser registration is reconciled rather than replaced. The original snapshots remain independent inputs.

## Integration behavior

- Image placement and inspector dimensions use the physical size of the exact pinned version, including the polish renderer's preview/selection geometry. Saving a new setup version does not move existing placements.
- Compact conversation CSS owns its responsive sheet. The old overlapping social overrides are removed while the shell's camera, area, dock, quest and Nearby rules remain in place.
- Places provides focused, retryable guided creation. The Universe, World and Room are separate durable operations with saved receipts; this is not an atomic three-record transaction.
- A foreground dialog dismisses More first. This prevents an obsolete menu keyboard trap from capturing Tab during account/room recovery.
- Default-off legacy image setup remains able to submit unrelated invalid fields and show their validation errors. The sizing gate checks physical-size changes without swallowing depth/collision validation.
- Browser SSE fault fixtures match the endpoint pathname, including the image capability query. Offline/reconnect assertions require a captured or blocked real stream rather than assuming an exact URL matched.

The admission page and preview controller preserve their explicit opt-in configuration. Format requirements remain one-way once persisted; incompatible or missing image reader descriptors block routine replacement and rollback. The integration does not activate a deployment or provision credentials.

## Reproducible verification

Run `npm run check`, `npm test`, `npm run build`, `npm run verify` and `npm run verify:container-files`. The last command reconstructs the declared runtime file layout and starts it locally; it is not a Docker or host-deployment test.

Relevant browser groups are registered in `scripts/test-browser.mjs` and the workflow matrix:

- `editorpolish`, `worldpolish`, `shellpolish`: source polish behavior and actual embedded-content/editor/menu journeys
- `imagesizing`, `imageversions`: native size/version/renderer agreement and immutable placement pins
- `compactconversations`, `placescreation`: compact chat and guided place creation/focus/recovery
- `signup`, `friendjourney`: standalone admission and the actual invited-friend path through private creation, sized artwork, chat and reload
- `imageprotocol`: actual unchanged legacy client versus the new reader boundary; requires the exact baseline checkout through `UNIVERSE_LEGACY_SOURCE`

The canonical core, HUD, framing, windows, image and Nearby groups remain registered with their behavioral assertions. A registered check is not itself a passing result: use the exact candidate's test evidence or workflow outcome.

All local data, accounts, passwords, invitations, PNGs and intercepted embeds used for verification are synthetic. Chromium uses software rendering. Narrow viewport/touch emulation does not certify physical phones, hardware frame rate, Safari/Firefox, hosted media, deployment, or whole-Universe feature parity. The primitive asset workshop remains a separate contribution.
