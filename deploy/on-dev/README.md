# Universe 3D dev deployment adaptation

Status: prepared and locally tested, **not published, activated, or deployed**.
This is a real implementation for one dev app, based on the current StudentHub
on-dev operating pattern, with separate protection for 3D's persistent data.

## What this provides

- Add `on-dev` to an approved, open, non-draft, same-repository PR targeting
  `main`. The latest eligible label event selects that PR's exact current head.
  Subsequent pushes rebuild it. Forks and labels from users without repository
  write/maintain/admin permission cannot select a candidate.
- Remove the selected label or close/merge the PR: the next remaining eligible
  label wins; if none remain, use current `main`. Unlike StudentHub, this version
  does not automatically remove labels from other PRs, avoiding a read/delete
  label race. Keep only one labelled PR for the simplest operation.
- Candidate tests and image builds run without registry-write or deployment
  credentials. A different clean runner publishes the exact tested-source image;
  another credential-free job smoke-tests its immutable digest with disposable
  storage. The trusted switch job never executes candidate code or containers.
- Before any switch, re-read desired state, verify source and image attribution,
  installed Coolify version, app settings, exact data-volume identity, pending
  deployments, public health, and data/runtime compatibility.
- One fixed non-cancelling switch queue, plus a persistent GitHub deployment
  marker before the first Coolify write. An unresolved marker stops later runs.
- Patch only the two image reference fields, read them back, start once, poll the
  exact Coolify deployment, verify health, exact served SHA/tree/controller/run/
  build-attempt and unchanged public access policy. Save success and failure
  receipts. Never report an HTTP 200 or a successful build as a successful deploy.

No accounts, owner bootstrap, roles, admission settings, environment variables,
databases, mounts, services or volumes are edited by this controller. No database
backup, restore, migration command, delete, or automatic rollback is included.
Application startup itself runs the repository's existing migration code.

## Important evidence boundary

Coolify's ordinary read API provides **configured** image fields, not Docker's
actual running image digest. This code records `configuredPin` and
`runtimeDigestVerified: false`. It can verify a finished deployment, configured
immutable digest, unchanged visible settings/mounts, and independently served
build identity. That is useful evidence, but not host-level digest attestation,
exclusive-writer proof, a data backup, or end-to-end gameplay QA.

`inspect.mjs` captures the current configured pin through read-only API calls.
Never rename it a running digest. A true running digest requires owner-authorized
host/container inspection or another trustworthy attestation source. There is no
new host agent or broad persistent host credential in this implementation.

The installed Coolify version has not been inspected. The adapter follows the
current official source and StudentHub's working `sha256-<hex>` digest-tag form.
It refuses a different installed version from the owner's reviewed version.

## Data/runtime compatibility

Automatic releases require the same conservative compatibility fingerprint as
both trusted main and the currently served build. It includes all server files,
their transitive shared local imports, runtime operator/health scripts, dependency
manifests, the trusted runtime image recipe, and reviewed Node base image.

Frontend-only changes can therefore proceed automatically after normal approval
and tests. Changes to backend/shared storage/protocol code, dependencies or the
runtime image stop for a separate compatibility review, even when a human may
ultimately judge them schema-compatible. This deliberately catches persistent
formats such as image capability JSON that SQL-only scans miss. It is not a
static proof that arbitrary approved code is harmless.

For a backend/storage change, use a separately approved plan: verify a recoverable
backup, run compatibility/migration checks on a disposable copy, review downgrade
behavior and data written during the preview, and perform an explicit rollout.
Do not reset the fingerprint, substitute a claimed digest, or use the initial
activation exception to bypass a known incompatible live build.

## One-time owner setup, after code/publication approval

1. Align the repository. At preparation time release/mvp-open-signup was
   `bb7e5122be05756ac115225bf957635fe6e8d683`; main was
   `cab9b9736a5fc3dafa6ff83953b79225add4b3e8`. GitHub reports release **85 commits
   ahead and zero behind** main. Review and promote that release history to
   main, then apply this adaptation on top. Do not build friends' previews from
   the old main. Keep `main` as the default/trusted controller and fallback.
   Preserve the unpublished gameplay branch separately; it is not in this patch.
2. Review the patch/CI, protect main and deployment-related files, and approve
   publication separately. Leave `UNIVERSE_DEV_ENABLED` unset until setup and
   the initial activation are ready. This task did not push or open a PR.
3. Retire/leave disabled the old preview controller. If
   `UNIVERSE_PREVIEW_ENABLED=OWNER_APPROVED`, the new path refuses to run. Confirm
   no separate operator, webhook, scheduler or Coolify auto-deploy can change the
   same resource while this controller owns it. GitHub concurrency cannot lock a
   manual Coolify user or another repository.
4. Verify the existing app in the installed Coolify version, without changing
   identity or storage:
   - App UUID `qwgitldz6ttlyqotoiy6fegd`, Docker Image, URL
     `https://3d.dev.bawes.net`, port 4190, no host port mapping
   - Exactly the existing named volume `qwgitldz6ttlyqotoiy6fegd-data` mounted at
     `/data`, no host bind, preview suffix or file overlays
   - Standalone Docker, zero additional servers, consistent container naming
     enabled (intended stop-before-start), auto-deploy and preview-deploy disabled
   - Health checks enabled, using the retained image HEALTHCHECK or exact CMD
     `node scripts/healthcheck.mjs`. Default curl/wget HTTP health checks are not
     compatible with this minimal Node image/public Host validation.
   - No custom Docker run options or pre/post deployment commands. Confirm the
     hidden inline Dockerfile is empty, because it can affect image selection.
   - Verify existing runtime environment still points `UNIVERSE_DB` to
     `/data/universe.sqlite` and preserves upload/asset locations, origin/hosts,
     TLS, signup, owner and security settings. Do not paste secrets into logs.
   Ordinary API reads deliberately cannot establish hidden environment values.
   Changes to any of these settings need their own approval; this script does
   not fix configuration automatically.
5. Verify a current recoverable SQLite/WAL plus asset backup and the actual live
   container's digest, mounts and writer situation with owner-authorized tooling.
   Coolify's consistent-name configuration is intended to avoid rolling overlap,
   but its upstream stop path can swallow errors. API-only checks cannot prove
   that no other container has this volume mounted. Preserve the current app and
   volume. No destructive backup/restore/reset recipe is supplied.
6. Credential setup requires separate action-time approval. Native Coolify API
   tokens are **team-scoped**, never application-scoped. Required abilities are
   `read`, `write`, `deploy`; not `root` or `read:sensitive`. Prefer an already
   isolated team containing only this dev resource. Do not hand a shared-team
   all-app/root token to this pipeline. If isolation needs access/resource changes,
   review and approve those changes separately. The in-code UUID allowlist helps
   avoid mistakes but does not narrow the token's server-side authority.
7. Create and restrict GitHub environments `universe-3d-dev` and
   `universe-3d-initial-activation` to protected `main`. Put credentials only in
   their environment secrets `UNIVERSE_DEV_COOLIFY_BASE` and
   `UNIVERSE_DEV_COOLIFY_TOKEN`. Require owner review on initial activation;
   routine dev may run automatically if the owner approves that operating scope.
   Set variable `UNIVERSE_DEV_COOLIFY_VERSION` to the exact installed version
   whose contracts were reviewed. Keep the environment secret unavailable to
   branch jobs. No new long-lived GitHub token is required; job-scoped
   GITHUB_TOKEN handles labels-read, publishing and deployment receipts.
8. Check public GHCR pull access for `ghcr.io/bawes-universe/universe-3d`. The
   existing MVP publication uses this package; this path requires anonymous
   smoke pulls. A permissions failure stops before live deployment. It never
   changes package visibility or adds credentials automatically.
9. First activation only: current live health has no build identity. Prepare the
   owner-reviewed baseline described below. Run on main with
   `initial_activation=true` after approval. Review the resulting full receipt,
   host digest/mounts, existing accounts/rooms/assets and a two-person friend
   session. Once proven, remove the one-time baseline variable. A later run with
   absent/incompatible health identity cannot silently reuse an invented baseline.

### Initial activation baseline

The initial GitHub environment variable `UNIVERSE_DEV_INITIAL_BASELINE` is JSON:

```json
{
  "schemaVersion": 1,
  "configuredPin": "ghcr.io/bawes-universe/universe-3d@sha256:<verified-current-digest>",
  "sourceRevision": "<verified-current-source-sha>",
  "compatibility": "<new-candidate-compatibility-reviewed-against-current-data>",
  "ownerVerifiedBackup": true,
  "ownerVerifiedRunningDigest": true,
  "verifiedAt": "<actual-UTC-verification-time>"
}
```

Do not copy claimed historical digests into this variable without checking.
It must be under 24 hours old and match the freshly read configured pin. The
initial rollout must select main with no on-dev PR holding the slot. The operator
attestation is explicitly labelled as such in the receipt. It is accepted only
for a healthy legacy build lacking build metadata; it cannot override an explicit
incompatible fingerprint. Approval of preparation did not authorize this rollout.

Read-only inspection after approved credential setup:

```sh
COOLIFY_BASE=... COOLIFY_TOKEN=... COOLIFY_EXPECTED_VERSION=... \
  node deploy/on-dev/inspect.mjs
```

Use the supported secret mechanism rather than writing actual values in a shell
history. This command never changes the app. Its generated report contains only
sanitized configuration hashes/pins and public health identity.

## Future routine assistant operation

After end-to-end activation and user authorization for the particular preview:

1. Read the exact PR/head, make sure it is approved and targeting main, and ensure
   the desired app changes fit the unchanged compatibility contract.
2. Use the existing GitHub label action to add `on-dev`. No workflow_dispatch,
   raw Coolify token, Hermes relay, new app or new volume is needed for this step.
3. Follow this workflow's run, stages and artifacts. Read the matching
   `on-dev-deployment-<run>-<attempt>` receipt, not just a green workflow badge.
   Successful runtime outcomes are `DEPLOYMENT_VERIFIED` or `ALREADY_CURRENT`.
   `DEPLOYED_BUT_SUPERSEDED` means another desired head must reconcile.
4. Confirm the URL's public build identity matches the recorded source, tree,
   run and build attempt before sharing it with friends. Gameplay approval still
   needs its own normal test scope; deployment correctness is not bug-free play.

Applying on-dev is a deployment request after activation, not just tagging.
Do not apply it without the user's release authorization. Keep the label only
when subsequent pushes should also deploy under that approved scope.

The GitHub connector can add/remove labels and read Actions/artifacts but has no
workflow_dispatch action. For a safe normal retry where there is no unresolved
mutation marker, remove then re-add on-dev, or use an owner Actions rerun.
A recovery lock is never solved by relabelling or blind reruns.

Known event coverage: main-only pull_request_target is an intentional trust
boundary. Remove on-dev before retargeting a PR away from main. If already
retargeted, an owner must manually reconcile from Actions on main (or a separately
authorized later main/label event). No periodic polling or extra wake workflow is
installed. A lost/suppressed webhook likewise needs an explicit reconciliation.

## Failure recovery

- Build/publish/smoke failure: no live switch; read `on-dev-run-*` and Actions logs.
- Preflight/selection change before image write: no runtime mutation. A created
  but unused marker is made inactive when confirmed safe.
- Any ambiguous or failed write/start/poll/verification: save
  `RECOVERY_REVIEW_REQUIRED`, leave a durable GitHub deployment failure/in-progress
  marker, and stop subsequent switches. Do not automatically retry POST/PATCH.
- The old service may still be healthy, the configured pin may have moved, or the
  new service may already have started. Inspect the exact recorded deployment,
  configured pin, actual container, visible data and backed-up state before any
  next write. Do not assume which state from a failed HTTP response.
- After owner-authorized recovery and verification, mark only the investigated
  GitHub deployment marker `inactive` (or record a confirmed successful outcome).
  This is an explicit owner operation, not a bot bypass. Then reconcile desired
  state again. Image rollback cannot undo startup migrations or new user data;
  never restore an old SQLite file/volume automatically.

## Files and verification

- `.github/workflows/dev-on-dev.yml`: seven jobs, pinned actions, narrow privileges
- `github.mjs`: live label selection and durable deployment markers
- `source.mjs`: exact source binding and conservative runtime/storage fingerprint
- `Dockerfile`, `publish.sh`, `image-smoke.sh`: build/publish/smoke isolation
- `coolify.mjs`: bounded API surface, app/storage/configuration checks, public probes
- `switch.mjs`: serialized state machine, persistent receipts and failure recovery
- `inspect.mjs`: read-only setup evidence
- `server/build-info.mjs` and health wiring: baked public revision identity
- `tests/dev-on-dev.test.mjs`: synthetic fixtures and a real local health-server test

Run `node --test tests/dev-on-dev.test.mjs`, `npm run check`, `npm test`,
`npm run build`, `npm run verify`, `npm run verify:container-files`.
The delivery README/evidence gives exact results and untested stages. The existing
container-file check models the root recipe; the delivery additionally checks
the new recipe's context and runtime files. Neither substitutes for Docker.
