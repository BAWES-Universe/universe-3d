# Isolated hosting assessment

The app currently runs as one Node.js 24 process with a SQLite file and room-scoped live SSE. No deployment has been performed. Do not put the database on ephemeral serverless function storage or launch multiple writers behind a load balancer.

## Assessment to request from the existing Universe dev operator

Please assess whether this standalone 3D app can run alongside the existing Universe development stack, without changing that stack. Start read-only and return a proposed plan before provisioning, changing routes, adding credentials, restarting services or altering firewall rules.

1. Record OS/CPU architecture, available RAM/CPU/disk, existing container/service layout, peak resource use, available domain/TLS routing and backup arrangements. Compare the measured app baseline with spare resources; do not infer user capacity from idle memory.
2. Propose a separately named Node24 service/container, dedicated persistent data volume, separate hostname and explicit quotas. Preserve the current development server, database, ports, credentials and process ownership.
3. Inspect whether existing LiveKit/SFU, TURN and broadcast infrastructure can support an isolated namespace/room prefix and separately scoped credentials. Report versions, SDK/protocol compatibility, host/origin restrictions, egress capacity and the exact adapter work needed. Never reuse production room names or broad administrative credentials.
4. The current app uses direct peer WebRTC and has not verified real audio/video packets. Reusing an SFU is not a URL-only change: token issuing, participant authorization, publish/subscribe roles, meeting/proximity/broadcast lifecycle and cleanup need a tested adapter. No new SFU is requested without assessing existing resources.
5. Before public access, propose reverse-proxy Host/Origin validation, trusted-TLS secure-cookie configuration, registration/bootstrap owner policy, request/body/storage quotas, backups and restore drills. Do not disable current origin protections to make the preview load.
6. Plan private review access, health checks and a small staged acceptance test: independent accounts, scene durability/restart, immediate access revocation, SSE reconnect, correct microphone/camera permission behavior and actual cross-network media. Physical phones and resource measurements remain gates.
7. Provide an isolated rollback: stop/remove only the new service and route, preserve its data snapshot, and verify the existing Universe dev service remains healthy.

Return feasibility, a concrete isolation diagram/list, required operator permissions, any likely costs and missing adapter work. This is an assessment request, not permission to mutate existing infrastructure, generate credentials or deploy.

## Measured and unmeasured

Run `npm run measure:server` after `npm run build` for `evidence/server-baseline.json`. It measures only idle process RSS/CPU and one local participant posting presence at10Hz, plus distribution byte sizes. It does not include a video SFU, TURN relay, many participants, external network traffic or physical-device rendering. See the report's exact environment and limits.

A Node24 runtime needs the server, src data/schema modules, built dist and a writable dedicated data directory. The browser renderer executes on the visitor's GPU/CPU; the server does not require a rendering GPU. Headless software-WebGL CI is intentionally a different environment and should not be used to predict client frame rates.
