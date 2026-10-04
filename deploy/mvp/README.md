# MVP image publication

The single publication action is **an authorized publisher pushing the reviewed
candidate commit to `release/mvp-open-signup`** in `BAWES-Universe/universe-3d`.
Preparing either draft PR does not publish. This does not require a `main` merge.
Only that exact branch's push invokes `.github/workflows/mvp-image.yml`.

Before that push, review the application and workflow together and confirm the
candidate's checks. The release workflow independently requires the complete
existing `verify.yml` suite at the exact triggering SHA, including every browser
matrix group. Its reusable call returns the verified tree. The normal push
workflow excludes this one branch to avoid running the same suite twice; PR
verification remains unchanged.

The image is `ghcr.io/bawes-universe/universe-3d` for `linux/amd64`. The build uses
`deploy/preview/Dockerfile` and the source `.dockerignore` allowlist. Its base is
the official `node:24-bookworm-slim` image, pinned to index digest
`sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`.
Docker Hub resolved that digest on 2026-10-04; its amd64 image reports Node
24.21.0. Updating the pin requires a reviewed change. It is a provenance pin,
not a claim that vulnerability scanning has passed.

The build runner has only `contents: read`. A fresh publish runner downloads
this run's artifact by ID, validates its receipt, archive hash and image labels,
and never checks out or executes the application. Only that job has
`packages: write`. It uses the ephemeral GitHub token for registry login, never
as a build argument or application environment variable, and removes its
isolated registry configuration on exit. No PAT or new persistent credential
is required.

The tag is `sha-<full-source-sha>-<run-id>-<publish-attempt>`. Tags can move;
use the returned **`ghcr.io/bawes-universe/universe-3d@sha256:…`** reference for
handoff. The publish job resolves the manifest from the registry and confirms
its config digest matches the built image ID. The `mvp-release-<run>-<attempt>`
artifact contains `release.json`: source SHA/tree, workflow SHA/blob, base pin,
archive hash, image ID, build attempt, publishing run/attempt, tag, digest and
run URL. It is saved before the smoke job and records smoke as pending; the
separate smoke job conclusion and summary provide smoke evidence. Re-running a
failed publish job uses a new publish-attempt tag while retaining the original
build-attempt evidence.

GHCR creates new packages private. Public visibility for this package is the
approved MVP choice, but the workflow does not change account/package settings.
The publisher must verify that setting through the actual package page. The
final smoke job has no token permissions, uses an empty Docker configuration,
and pulls the exact digest anonymously. If the first pull fails because the
package is private, the image may already be published: read the receipt, make
the approved package public, then **rerun only failed jobs**. Do not push the
release branch again just to retry smoke. A failed anonymous pull must never be
reported as public availability.

Smoke runs the downloaded digest as `1000:1000`, without registry credentials,
network access, published ports or host mounts. It checks health, static assets
and presence of the promotion helper. This is a disposable local-mode packaging
check, not the six live MVP acceptance checks. It does not prove HTTPS, SSE
proxying, durable `/data`, owner promotion, deployment limits or a running host's
digest. Keep those checks with the deployment handoff.

The workflow does not deploy, roll back, accept comments as commands, use a
Coolify token, access a host, or enable the existing preview controller. Keep
host-specific configuration and account IDs out of repository files. Public
registration remains disabled in both Dockerfiles; the isolated deployment
explicitly opts into open signup and setup-only mode.

References: [GitHub reusable workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations),
[GHCR visibility and digest pulls](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
[registry manifest inspection](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/).
