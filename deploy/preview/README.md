# Universe 3D preview release pipeline

**Status: local code and synthetic tests only. Inert by default.** No image has
been published, workflow activated, credential read/created, server accessed or
preview deployed. The checked-in `enabled: false`, absent trust pin/base digest,
and unconfigured host route each independently prevent activation.

## What is implemented

- `preview-request.yml`: default-branch `pull_request_target` reconciles the
  existing `on-dev` label using fresh GitHub reads. It never executes PR code.
  One selected same-repository PR builds; no selected PR requests the separately
  approved baseline. Ambiguous labels fail closed. The existing GitHub token
  dispatches workflows; no new fine-grained token or broker is required.
- `preview-build.yml`: dispatch-only, trusted revision gated. A credential-free
  isolated container runs check/unit/build/package/container-file verification.
  A separate clean runner packages the exact SHA/tree with a trusted Dockerfile
  and reviewed digest-pinned Node 24 base. The publish job alone has
  `packages: write`; it loads image data without running it. A different job
  smoke-tests the actual registry digest without deployment authority. A trusted
  record job emits SHA, tree, digest/pin, exact run/attempt and completed checks.
  No ordinary push can publish. No `latest` deployment or shared Actions cache.
- `preview-controller.yml`: default-branch `workflow_run`, independently verifies
  exact upstream workflow path, approved workflow revision, repository/event and
  successful jobs in the exact attempt. A protected deployment environment is
  assigned only after the credential-free host-capability gate passes. The
  controller checks out only its separately approved revision; artifact JSON is
  parsed as bounded data, never executed. Simply merging PR-event YAML into main
  is not this trust boundary.
- `controller.mjs`: fenced serialization, fresh desired generation inside lock,
  replay rejection, reviewed schema compatibility before mutation, durable
  in-progress freeze before stop, stop-first writer termination, retained backup,
  immutable start, runtime verification, compatible rollback and honest freeze
  on uncertain recovery. Lost CAS responses are read back; uncertain state never
  triggers a rollback against a stale version.
- `coolify.mjs`: scoped HTTPS read/version/stop/PATCH/readback/start/deployment
  polling transport. Stop always sends `docker_cleanup=false`. The version-specific
  digest binding must be separately reviewed; no installed version is claimed.
  API completion/config readback is not evidence of a running digest or of zero
  writers.

Run the local safety suite with:

    node --test tests/preview-pipeline.test.mjs tests/preview-image-reader.test.mjs

It is also included by the existing `npm test` glob. Synthetic fixtures never call
GitHub, GHCR, Coolify, Docker or a host. They do not prove those systems work.

## Host helper: implemented, not installed

The missing operational code is now supplied. `host-runner.mjs` is a one-shot
host-local command, not a daemon, network endpoint, broker or credential issuer.
`host-protocol.mjs` invokes only an existing, explicitly reviewed command route
without a shell. It passes a bounded release request and code/config fingerprints;
it does not transmit credentials. No route is configured in this checkout.

- `host-store.mjs` implements owner-only durable state, atomic CAS/readback and an
  exclusive no-steal lock. A killed process leaves the lock and frozen intent for
  operator reconciliation; age or PID reuse never automatically unlocks it
- `host-system.mjs` performs real read-only Docker inspection through a configured
  local Unix socket, with an empty Docker config and sanitized environment. It
  pins the approved engine, machine and full host PID namespace. Full container,
  namespace, descriptor and memory-mapping evidence detects shared volume access,
  including mmap writers after FDs close and bind-mount aliases. Incomplete
  visibility fails closed
- Volume, controller-state and backup filesystems must have reviewed local durable
  semantics; this implementation permits ext4/xfs/btrfs and rejects network/tmpfs
  backing. Docker's `local` volume driver alone is not accepted as proof
- `host-evidence.mjs` checks fresh queue, mount, memory/disk, schema and running
  health evidence. Automatic app deployment must be disabled, every other app
  mutation must use the same host authority, and preview restart policies must be
  `no`. State/backups cannot reside on the application volume
- Consistent stopped-volume backups reject symlinks/hardlinks, enforce a byte
  bound, stream hashes, and fsync files, nested directories and the backup parent
  before claiming retention. No backup/volume deletion is implemented
- `host-initialize.mjs` is a separate local operator setup command. It records an
  already-running, observed, explicitly approved baseline exactly once; it refuses
  existing state and cannot start/stop an app. It is not exposed through workflows

This helper does not claim that Coolify accepts fencing tokens. Safety comes from
exclusive host-local control, durable intent, disabled alternative automatic start
paths and a conservative rule: **a lost/uncertain asynchronous request poisons the
transaction and forbids all subsequent recovery mutations**. It remains frozen
until an operator reconciles the request, queue, processes and durable state.
A positively observed terminal failure may recover only after fresh zero-pending
queue and writer proof. A queued stop response never counts as proof.

Every observation expires after 30 seconds and is refreshed before candidate and
recovery starts. Actual running digest, source revision, healthy application,
dedicated volume, schema and one-writer state must match. Stored tags do not count.
A complete approved release tuple also binds the host request to its original
run/attempt, controller revision, SHA/tree, image digest and pin; fingerprints alone
are neither authentication nor build provenance.

The helper requires an already authorized full-host observation/execution route.
No SSH access, privilege change, daemon, monitoring port or new token is assumed.
Unknown installed facts remain blockers; for the supported profile, the remaining
work is approval, installation/configuration and live acceptance, not writing the
lock, observation, backup, deployment or recovery implementations.

## Setup inputs for the separate approval

1. Reviewed controller commit on protected `main`; environment restricted to that
   ref. Set `UNIVERSE_PREVIEW_TRUSTED_REVISION` to that exact commit and explicitly
   review pipeline changes before moving it. Set `UNIVERSE_PREVIEW_ENABLED` to
   `OWNER_APPROVED` only after all gates are resolved and policy enabled in code
2. Reviewed exact Node 24 image digest, image/package visibility, and GHCR access
   for the existing build identity and host. Registry cost/visibility is not assumed
3. Isolated application UUID, dedicated volume, HTTPS route, installed Coolify
   version and reviewed `apiProfile` digest-field mapping. The supplied transport
   supports `name-at-digest-empty-tag` only when verified for that version; otherwise
   a small version-specific transport change is required before any PATCH
4. Existing deployment-environment token with the required read/write/deploy
   permission, and a complete list of reachable resources the owner accepts.
   Coolify tokens are team-bound. A UUID does not isolate them from other apps;
   reuse sufficient existing isolation or obtain separate approval for any change
5. An existing authorized command route in `hostExecution.command` with a review
   ID, launching Node 24 `host-runner.mjs --config <protected-config-file>` under
   the agreed host identity. Install the reviewed source unchanged; code/config
   fingerprints must match. Configure the existing authority in that approved
   execution context; the bridge does not copy tokens to the host
6. `hostLocal`: installation/exclusive-mutation approval IDs; exact container label;
   local Docker socket; reviewed engine ID/machine ID/full PID namespace; owner-only
   0700 state and backup directories; `universe.sqlite`; exact allowed health Host;
   explicit reserved memory/disk and backup-byte bounds; reviewed SQLite schema
   fingerprints. The API profile must identify the installed version's auto-deploy
   setting and establish that its queue listing includes pending jobs. Initialize
   state only after observing the approved baseline with `host-initialize.mjs`
7. An explicitly approved baseline release: SHA, tree, digest, schema, approval ID,
   original release record/run/attempt and selection epoch. Baseline is never
   silently advanced to latest main or to the previous healthy preview
8. Reviewed per-digest database compatibility entries: candidate input/output and
   intermediate schemas; previous digest's read/write schema support. Unknown
   compatibility blocks before stop. An additive-schema test alone is not proof
   for an arbitrary image digest or unrelated image-size/data changes
9. `imageReaderCompatibility` entries for the candidate, previous healthy image,
   and any approved baseline that may be selected. Each entry binds `digest`,
   `sha`, `tree`, `descriptorBlobSha`, `reviewId`, and
   `possibleStorageRequirements: { version: 1, requiredReaderCapabilities: [...] }`.
   `descriptorBlobSha` is the Git blob SHA of that exact source's
   `server/image-protocol-capabilities.json`, not a SHA of reserialized JSON.
   Review the binary's actual reader/writer behavior and startup configuration;
   a JSON capability claim is not a substitute for that review. The existing
   GitHub read authority must be able to read both immutable source commits

## Persisted format admission and the first deployment

SQLite table shape is not sufficient rollback evidence. The host independently
reads the image protocol floor and any physical-size fields in stored image rows
in the same read-only SQLite snapshot as the schema fingerprint. A floor is
required even with zero image rows: the new process can persist it at startup.
Sized rows also require the capability if the marker is absent. Unknown, duplicate,
empty or null floor values and malformed stored JSON fail closed. These reads do
not repair, lower or create a marker.

The same descriptor now declares `composition-furniture-v1` alongside
`image-physical-size-v1`. Any row in `room_furniture_protocol_floor` requires the
furniture reader, even after every placement has been removed. The host also
checks persisted `rooms.scene` objects: a `type: "composition"` placement requires
that reader even without a floor table or row. Empty/missing furniture-floor
tables and legacy scenes add no requirement. Unknown, empty or null furniture
capabilities and malformed room JSON fail closed. The historical `image-reader`
interface, error codes and `sqlite-metadata-and-image-rows` evidence tag are
retained; its read-only snapshot now includes furniture floors and room scenes.

The controller fetches bounded descriptor JSON at each target's exact source SHA,
checks the commit tree and Git blob hash, and requires the protected policy's
matching digest/SHA/tree/blob review. It never executes target code or accepts a
release artifact's reader claim. Both candidate and previous healthy image must
support the current storage requirements and the possible resulting requirements
before any stop or state mutation. Every advertised reader capability is included
in that possible floor, even when sizing is configured off; an off flag is not a
promise that the same binary can never persist it. Missing descriptors block even
when the current database has no floor.

After writer termination the host refreshes storage evidence immediately before
candidate start, and repeats it before rollback. Every valid floor observed during
candidate verification is retained even if health or selection later fails. A
subsequent lower, missing, unknown or incompatible observation freezes recovery.
Healthy durable state records the observed requirements separately from schema.
All existing lease, generation, queue, backup and schema gates still apply.

This means the initial transition from a descriptor-less legacy image to the new
sizing-capable image cannot run through the routine preview route. Writing a
marker cannot protect a legacy binary that never reads it, and disabling new
writes alone does not make that rollback safe. Before routine preview activation,
the operator needs a separately approved bootstrap/recovery plan that establishes
an already-running, reviewed compatible baseline and retained data backup. The
initializer only observes and records that baseline; it does not perform the
bootstrap. If compatibility cannot be established, the transition stays blocked.
A fresh-volume reset is a separate human-approved operation retaining the old
volume; there is no automatic bypass in this controller.

The same restriction applies when adding composition support to an image-only
baseline: the candidate may persist furniture, so its declared capability is
part of the conservative potential floor before any write. An image-only prior
release is not a safe rollback target, even when the current database contains
no furniture. A separately approved reviewed-reader bootstrap/recovery plan is
required. Merely adding the new table, editing a descriptor or turning a feature
off cannot authorize that transition.

Historical baselines/builds can be approved through `approvedBuildRevisions`.
The controller reads their exact original attempts. When a reviewed policy update
approves an already-published digest, the still-selected source/tree and original
label/force-push epoch must match before re-attesting only the new policy generation.
A current-revision `workflow_dispatch` with mode `reviewed-release` loads the exact
run/attempt from `reviewedReleases`; it accepts no arbitrary SHA/digest/run input.
This makes the approval reachable after the trust pin changes, without rebuilding
to discover a different digest. Remove/re-add, another PR,
or a force-push cycle remains stale. No arbitrary manual digest input bypass exists.

A host deployment also needs the complete immutable release tuple in the protected
`reviewedReleases` list (or the approved baseline). A digest-only compatibility
entry cannot be substituted for build provenance.

Explicit-digest exceptions and destructive resets are deliberately not automated.
They need human approval for the exact digest/action/data effect. A reset must use
a separately approved fresh volume and retain the old volume and backup; this
pipeline contains no delete/prune/reset operation. Recovered failures remain frozen
for operator review. A state-reconciliation-required result must be reconciled
under the same resource lease before any further host mutation.

## Bounded package verification

Both Dockerfiles copy `modules/asset-workshop` into the build and runtime stages.
The source `.dockerignore` admits only `model.js`, `geometry.js` and `view.js`
from that module; unrelated modules, nested data and private files remain
excluded. Adding a new shared source file requires updating this allowlist.

`npm run verify:container-files` independently builds each Dockerfile's declared
COPY layout in a temporary directory, applies the repository's supported
`.dockerignore` syntax, and starts each resulting runtime without `node_modules`.
Unsupported ignore/COPY syntax fails rather than silently bypassing the check.
This is CPU-only package evidence. It does not build a Docker image, exercise
container users/network/TLS, or establish host/deployment readiness. The report
is written to `evidence/container-files.json`.

## Verification and reuse provenance

Implemented behavior and test results are distinct from live proof. Docker is not
available in the implementation workspace: no image build/run, registry push,
GitHub Actions execution, actual host scope/capacity, proxy/TLS, persistence restore
or deployed invite journey has been verified by this work.

Read-only source patterns adapted:
- Universe label ergonomics/serialization at commit
  `09d6c170f96c0d12b77e35959524bd263727c5cd`, `.github/workflows/dev-server.yml`
  and `dev-server-switch.yml`. Its PR merge-ref credential boundary is not reused
- StudentHub digest smoke/release record/freeze at commit
  `9d8a9d170d1cebffa9cb80c124348f9c9a0665e8`, `.github/workflows/build.yml`
  and `deploy/coolify/automatic-staging.mjs`. Mutable-tag promotion and unconditional
  database rollback are not reused
- Action commit pins were resolved from the official actions repositories on
  2026-10-04. Their presence is a source pin, not a live supply-chain certification

API references:
- https://coolify.io/docs/api/endpoints/applications/stop-application-by-uuid
- https://coolify.io/docs/api/endpoints/applications/start-application-by-uuid
- https://coolify.io/docs/api/endpoints/applications/update-application-by-uuid
- https://docs.github.com/en/actions/reference/security/secure-use
