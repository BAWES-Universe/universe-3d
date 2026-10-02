# Isolated dev hosting readiness · 2026-10-02

The application runs as one Node.js 24 process with a SQLite file and live room-scoped SSE. No deployment has been performed. Do not use ephemeral serverless function storage or run multiple SQLite writers behind a load balancer.

## Code now supplied

- Explicit bind, exact Host/Origin allowlists and public-mode startup validation
- Always-Secure/HttpOnly/SameSite=Strict cookies under explicitly configured external TLS, without trusting arbitrary forwarded headers
- Public preview login-only admission, disabled guest creation/registration and a fail-closed offline owner bootstrap
- Offline reviewer provisioning that grants no ownership or durable place membership
- Multi-stage Node24 Dockerfile, non-root runtime, dedicated `/data`, one process and health check
- Same-origin mutation and current-session authorization remain active

Read `DEV-PREVIEW-OPERATOR.md` for the exact configuration, offline commands, proxy/SSE contract, acceptance gates and isolated rollback. Its examples use `preview.example.com`; the actual hostname and DNS/TLS/routing must be selected and confirmed by the authorized operator. The planned 1 CPU / 768 MiB envelope is a starting isolation limit, not tested capacity.

The file-layout verifier reconstructs the Dockerfile COPY stages, builds with installed lockfile dependencies, then starts the runtime files without `node_modules`. This detects missing build/runtime files. It is not a Docker image run or verification of container permissions, proxy routing or HTTPS.

## Measured local baseline

`npm run measure:server` on 2026-10-02 at 11:17 UTC recorded Node24.19.0 on shared Linux/Xeon hardware:

| Scenario | RSS | CPU |
|---|---:|---:|
| Five seconds idle | 42.9 MiB at end | 0 sampled process CPU ms |
| One participant, 100 presence updates at target10Hz | 55.7 MiB at end | 520 ms over 10 seconds, 5.2% of one core |

Local presence request latency: median6.5 ms, p9514.1 ms. All151 distribution files, including deferred chunks, fonts and licenses:3,338,857 raw bytes, estimated1,206,411 gzip bytes or986,197 Brotli bytes. The default app server sends uncompressed files; edge compression is an operator choice. These totals are not a measured first-page download.

These short measurements exclude an SFU, TURN relay, video, many clients, external traffic and browser rendering. They do not establish production or concurrent-user capacity. `evidence/server-baseline.json` records the exact environment and limits when generated. The visitor's device renders the 3D world; the backend does not need a rendering GPU. Software-WebGL CI cannot predict phone frame rates.

## Unrun operational gates

The operator must build/run a reviewed image, set the dedicated volume ownership, verify actual HTTPS/proxy/cookie/SSE behavior, test backup/restore, check reviewer workload and confirm the existing dev stack remains healthy. Docker is unavailable in the current build workspace, so those steps are unrun. No infrastructure, credentials, routes or running services were changed here.

Use separate service/data/hostname identities and preserve the existing Universe development stack. Never reuse a local first-guest database for the public preview. Keep registration closed and provision the owner/reviewers offline. Apply disk/log/resource limits and retain a consistent SQLite/WAL backup before updates.

## Media integration remains open

This source currently has direct-peer WebRTC signaling and no configured LiveKit/TURN adapter. Assess any existing approved infrastructure before planning reuse. Reuse needs server-scoped token issuing, room and role admission, publish/subscribe updates, removal/cleanup and genuine cross-network packet tests. It is not a URL-only configuration change.

A room prefix or second broadly privileged LiveKit API key does not provide cryptographic tenant isolation. The operator must identify actual project/instance/capability boundaries before credential use. Do not copy existing production room names or broad secrets. Recording egress needs a separate capability assessment. No new paid media service is part of this handoff.
