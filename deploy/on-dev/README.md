# Universe 3D on-dev

Deploy approved changes to the **whole app**, including normal backend changes
and migrations, through the existing GitHub Actions → GHCR → Coolify route.
This uses the current StudentHub label-driven pattern. No per-backend-change
fingerprint approval, exact-version pin, initial-baseline JSON or separate
first-activation environment is required.

## Normal operation

1. An approved same-repository PR targeting main gets `on-dev`.
2. The workflow selects its exact current head, tests it, builds an image without
   registry-write/deployment credentials, publishes on a separate clean runner,
   and smoke-tests that exact digest with disposable, network-isolated data.
3. A serialized trusted job rechecks current selection and the existing app,
   volume, hardening and deployment queue. It changes only the image name/digest,
   starts once, and verifies the completed deployment and live revision/health.
   A broken old app can receive its fix: prior public-health probes are diagnostic;
   the new app's exact revision and health are mandatory.
4. Source/digest/run receipts are retained. A failed run changes no database back
   automatically. The next authorized reconciliation reads actual queue, config
   and health; no manual GitHub-marker unlock is required for ordinary retries.

Latest eligible label wins; removing/closing it selects the next labelled PR or
main if none remain. Keeping only one labelled PR is simplest. Forks and labels
from accounts without write/maintain/admin permission cannot select a branch.
The existing GitHub connector's label actions are enough for routine use.
No Hermes relay is needed for each release once the host route is configured.

The controller and image recipe always come from trusted main, even when a
preview branch changes its own copies. Preview application/backend/migration/
dependency changes use the normal route. Controller/workflow changes take effect
only after normal review onto main; candidate copies never gain deployment secrets.

## Data and recovery

Normal migration code follows the same test/build/deploy path as application
code. This repository currently runs schema initialization/migrations at startup;
there is no new migration framework here. Tests exercise disposable databases.

The developer/assistant must explicitly identify destructive operations such as
dropping user data, irreversible transformations or restoring an older database.
Set `deploy/release-safety.json` `destructiveDataChange` to true for such a release;
the routine workflow refuses it. This declaration complements code review; it is
not an automatic classifier or proof that arbitrary SQL is harmless. Do not clear
it to bypass an unresolved destructive operation. Those cases require an explicit
owner decision and a separate approved execution/recovery plan.

A recoverable backup belongs to the existing dev-host operating route. Take a
fresh consistent SQLite snapshot and cover all assets before first activation;
use the existing repeatable backup job/hook for subsequent releases. An online
SQLite backup includes committed WAL changes; blindly copying only an open main
`.sqlite` file does not. If using a stopped-volume snapshot, include DB/WAL and
assets together. Check that a copy opens and passes integrity checks.

**This workflow does not claim to create or verify host backups.** The host owner
must confirm the actual backup primitive, recovery location and coverage before
enabling it. Do not export real account/room data into public GitHub artifacts or
untrusted branch CI. First-rollout compatibility checks on real data copies stay
in the owner's approved environment. Routine releases use the established route,
not a fresh chat attestation every time.

No automatic database restore or blind image rollback is implemented. An image
rollback cannot undo migrations or user writes. For a failed deployment, inspect
its receipt/current state and use the established recovery route; destructive
restores remain an explicit decision. HTTP mutation requests are never blindly
retried within a run. No data reset, owner bootstrap or role changes are performed
by deployment automation.

## Existing app and one-time setup

After publication/review and owner-authorized host setup:

- Keep app `qwgitldz6ttlyqotoiy6fegd`, URL `https://3d.dev.bawes.net`, port 4190 and
  volume `qwgitldz6ttlyqotoiy6fegd-data` mounted at `/data`. Preserve DB/asset paths.
- Keep exactly the reviewed live hardening:
  `--cap-drop=ALL --ulimit nproc=512:512 --ulimit nofile=4096:4096`.
  Unknown extra options/mounts/commands are rejected. Do not remove hardening to
  pass a gate. No new-privileges option is assumed on a Coolify parser that cannot
  express it correctly.
- Use standalone Docker with no additional servers, and consistent container
  naming for intended stop-before-start. Agree one routine deployment writer and
  disable competing real deploy triggers. An inert auto-deploy flag on the
  placeholder source is not itself a blocker. API checks cannot prove that no
  unrelated container mounts the same volume; the host owner confirms that once.
- Ordinary application starts here have no Coolify preview PR ID. The existing
  volume preview-suffix flag may remain unchanged; the actual mount is checked.
- The image has the tested Node HEALTHCHECK. Coolify can leave its own generated
  health check disabled, or use the image check/exact CMD
  `node scripts/healthcheck.mjs`. The controller also probes public health and
  exact served revision. No curl installation is required.
- Confirm hidden runtime environment and empty inline Dockerfile using existing
  owner access; do not expose secret values. Keep `/data/universe.sqlite`, origin,
  TLS, signup, owner and asset settings unchanged.
- Complete a fresh backup and the one controlled first rollout using the existing
  approved host route. The current live build lacks revision metadata; that
  alone does not require a separate environment or special attestation file.

Hermes reported installed Coolify **4.4.2** and verified the required API routes
and digest encoding. Version is recorded for diagnostics; actual response shapes,
app/storage guards, digest readback and deployment/health checks determine whether
a run can proceed. There is no untested promise that every future version works.

Use one GitHub environment, `universe-3d-dev`, restricted to trusted main, with
`UNIVERSE_DEV_COOLIFY_BASE` and `UNIVERSE_DEV_COOLIFY_TOKEN`. Native Coolify tokens
are team-scoped. Use the existing approved credential route or obtain only the
necessary one-time secure setup approval; minimum abilities are read/write/deploy,
not root/read:sensitive. The UUID allowlist does not narrow a team token's actual
server-side authority. Never put token values in chat, source or reports.

Set `UNIVERSE_DEV_ENABLED=true` only when setup is ready. Leave old
`UNIVERSE_PREVIEW_ENABLED=OWNER_APPROVED` unset, since the superseded controller
must not compete. There is no `UNIVERSE_DEV_INITIAL_BASELINE`, required version
variable or `universe-3d-initial-activation` environment in this version.

The source is currently reviewed on release/mvp-open-signup. Promote its reviewed
history and this adaptation to main as part of completing the standard route;
main remains the trusted controller/fallback. A merge to the release branch also
invokes its existing MVP image publication, which is separate from live deployment.
No gameplay candidate was silently merged into this adaptation.

## Evidence and limits

Success means completed Coolify deployment + configured immutable digest + exact
live SHA/tree/controller/run/build-attempt + public health/static/access checks.
Coolify's ordinary API does not prove the actual running host digest. Receipts
explicitly retain `runtimeDigestVerified:false`; use host inspection when needed.

`inspect.mjs` is read-only and emits sanitized config/health/version evidence.
The normal PR verification workflow tests the application and builds/smokes the
real on-dev Docker recipe without registry writes or deployment secrets. Branch
pushes with an open PR use PR CI; main pushes and the MVP reusable verification
remain covered, avoiding duplicate branch-push/PR matrices.

Main-only pull_request_target is intentional: remove on-dev before retargeting a
PR away from main; if already retargeted, reconcile manually from Actions on main.
A missed webhook likewise needs a reconciliation. The label is a deployment
request, so apply it only within the approved dev-release scope.
