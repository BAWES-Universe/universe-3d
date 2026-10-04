# Editing an image setup

Build → Custom images → Edit setup opens the selected asset's current PNG and
setup. Full room editors can change standing/floor/custom depth, the custom
ground pivot, and eligible collision cells. Save new version creates an
immutable version of the same asset. It does not place anything or change the
room scene. The library shows the version number; Place explicitly selects
that displayed version for a new object.

Every saved object, unsaved object and already selected placement tool retains
its original `{assetId,versionId}`. Old and new setups can coexist. Creating a
version does not move objects, advance the room's scene revision, change active
collision or grant edit rights. Normal placement, shared scene commits,
personal-area boundaries and Undo continue to validate the exact selected pin.

## What can change

The PNG bytes, dimensions, digest and definition's floating setting remain
fixed. Floating cannot be changed after upload; a different floating mode needs
a new image definition. Nonfloating collision grids retain the existing
32-pixel-multiple and binary-cell rules. Depth uses the established native 3D
floor/upright plane and normalized pivot contract. Edit details remains the
separate workflow for mutable library name, description and tags.

This increment does not replace PNG bytes, provide a historical-version browser,
upgrade existing instances or delete retained versions. A setup save always
requires a real depth/collision change. An unchanged setup consumes no version
or storage allowance.

## Conflicts and interrupted saves

A setup draft names both its source version and expected library revision.
Another setup save, metadata edit, archive or restore can make that draft
stale. The conflict preserves the local fields and requires an explicit
Review latest version before a changed submission. It never silently rebases
the user's setup or rewrites someone else's current version.

An interrupted save keeps its exact operation identity and payload. Check
version save status can confirm a durable commit; Retry same version save
reuses that identity. Cancellation of a network request does not prove that its
transaction was cancelled. Closing the panel preserves a scoped draft or
unresolved submission without publishing it. Room/account and authority changes
fence late previews and responses.

Discard setup draft clears only the local unsent draft and returns to the
library. Reopening then uses the saved setup. It sends no request and remains
available after management permission is removed if the library is still
readable. A pending or uncertain save must be reconciled before its recovery
identity can be discarded. Back and Close continue to retain the draft.

A receipt identifies the version that was published separately from the
current library entry. If version 2 committed and another editor then published
version 3, confirming the first save returns published version 2 and current
entry version 3. It cannot replace the latest library choice with version 2 or
silently select a version for world placement. Legacy upload receipts retain
their old wire format; the library refreshes its current choices afterward.

## Retention, quota and permissions

The implementation stores a complete copy of the original PNG for each new
version. Every retained copy counts toward the existing 50 MiB room image-byte
limit. There is also a local bound of 100 retained versions per asset. These
are implementation limits, not claims about upstream limits. Archiving keeps
all versions and their quota usage. Reaching the definition-count limit alone
does not block another setup of an existing definition.

Fresh setup saves require an active asset and current full room-management
authority. Personal-area ownership and upload authorship are not management
grants. Version, byte storage, current pointer, revision and receipt commit in
one SQLite transaction. Permission and room-session changes are checked again
at that transaction. A failed write leaves all of those records unchanged.

An archived asset cannot receive a fresh setup or a new placed copy. Its exact
saved pins remain readable/renderable under the existing room rules. A manager
can still confirm a previously committed setup after archive, without restoring
placement permission. Cache updates apply the latest known asset lifecycle
revision across version keys while preserving each immutable version body.

Notifications follow durable commit and contain only identifiers, status and
revision. Delivery is best effort, as with existing asset operations; the
receipt is the recovery mechanism. This is not an exactly-once SSE guarantee.

## Source boundary and verification

The [pinned entity editor documentation](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/docs/map-building/inline-editor/entity-editor/index.md)
supports depth editing and immutable floating mode. Its
[front command](https://github.com/BAWES-Universe/workadventure-universe/blob/bae18306bdfa63e58cd4124b1a3b5b290b61c286/play/src/front/Phaser/Game/MapEditor/Commands/Entity/ModifyCustomEntityFrontCommand.ts)
updates a shared prefab and explicitly updates matching placed entities' depth.
This application's immutable pin policy deliberately keeps those placements
unchanged. It is partial EDIT-07/08 coverage, not automatic propagation parity
or exact 2D painter-order fidelity.

See [the image service contract](server/image-assets-service-contract.md) for
the strict wire format, authority, receipt and storage rules. Unit, independent
HTTP/SQLite and controlled browser tests exercise the protocol and interruption
boundaries. Actual-game acceptance uses generated local PNGs, native browser
input and explicit old/new placements. Run
`node scripts/test-browser.mjs imageversions` for the new controlled/full-game
group, and `npm run test:browser:images` for the existing image workflows.
Test registration alone is not a passing
result; use the exact source revision's workflow result. Software WebGL and
touch emulation do not establish physical-device or hosted-deployment results.
