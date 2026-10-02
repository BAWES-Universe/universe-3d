# Isolated private dev preview: operator handoff

This is a source-code and deployment-planning handoff. No server was accessed, route created, service restarted, credential issued, or deployment performed by this work. Configuration examples use the placeholder hostname **preview.example.com**. An authorized operator must choose and verify the actual DNS, TLS, routing and reachability before use.

## Boundary and deployment gates

Keep the existing Universe dev application, databases, credentials, ports, routes, volumes and process ownership unchanged. Use a separately named standalone Node 24 container, a new dedicated `/data` volume, **one replica**, a **1 CPU / 768 MiB** limit, and the existing approved reverse-proxy infrastructure only after checking spare capacity. These limits are a proposed isolation envelope, not measured user capacity. Do not provision a paid service or make a new spending commitment from this handoff.

The supplied Dockerfile runs as the existing image's non-root `node` UID/GID (1000/1000). Only `/data` needs writable persistent storage. Its runtime needs no npm install and no browser/GPU. `EXPOSE 4190` is metadata; it does not publish a port. No host port, host-network mode, privileged mode, Docker socket, host filesystem or existing dev data mount is required or assumed.

Before opening the route, the operator must:

1. Review the exact source revision and test results, select and scan an official Node 24 image, and record/pin the tested base-image digest. The Dockerfile tag is not an immutable supply-chain pin. Build in an already approved system; the multi-stage build uses the committed npm lockfile.
2. Create/verify a distinct writable volume owned by UID/GID 1000, with directory mode 0700 and adequate disk quota, backup and retention policy. Do not reuse a local guest database or the existing Universe dev database. SQLite/WAL must be on durable local storage with correct locking, not an ephemeral function filesystem or a multi-writer/network-filesystem deployment.
3. Arrange a separately named proxy route for the exact hostname and valid TLS, preserving its original Host upstream. Redirect external HTTP to HTTPS before requests reach the app. Apply HSTS at the edge only according to the operator's approved domain policy. Permit plaintext application ingress only from the trusted proxy and health-check path; do not publish port 4190 on the host or expose the container to untrusted peers. Host/Origin checks do not replace network isolation.
4. Confirm the 1 CPU / 768 MiB process envelope and bounded disk/log use do not consume resources reserved for the existing dev stack. Use one replica, a read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, and an appropriate PID/log limit. The single-process SQLite/SSE design is not horizontally replicated.
5. Bootstrap the owner offline, provision specific reviewers offline, and complete the acceptance tests below before admitting those reviewers. Opening registration to the Internet is not part of this plan.

No ready-to-apply Traefik/Compose manifest is supplied: the assessment did not establish the actual proxy network, certificate-resolver, deployment-controller or existing route identifiers. The operator must map the contract below to the real stack without overwriting any existing service or restarting it unnecessarily.

## Explicit environment contract

The intended private preview configuration is:

```dotenv
NODE_ENV=production
UNIVERSE_MODE=public
UNIVERSE_BIND_ADDRESS=0.0.0.0
PORT=4190
UNIVERSE_DB=/data/universe.sqlite
UNIVERSE_ALLOWED_HOSTS=preview.example.com
UNIVERSE_ALLOWED_ORIGINS=https://preview.example.com
UNIVERSE_TLS_MODE=external
UNIVERSE_COOKIE_SECURE=always
UNIVERSE_REGISTRATION_MODE=disabled
```

These values contain no credential. Configure them only for the new standalone service. `public` describes an externally reachable, TLS-terminated runtime; admission is still private and operator-provisioned.

- Hosts are exact authorities, with an explicit port only when actually present in the browser's authority. Origins are exact canonical scheme/host/port values, without a trailing slash, path, wildcard, query, credentials or fragment. Comma-separated lists may be used only for explicitly reviewed additional names, with matching entries in both lists. The Origin must also match the current request's Host.
- Public startup refuses missing lists, non-HTTPS origins, open web registration, relative/in-memory databases, implicit binding or implicit TLS/cookie configuration. A fixed nonzero port is required.
- Public write requests require an allowed Origin. Navigation and the unauthenticated GET health/access policy endpoints may omit Origin, but every request still needs an allowed Host. Cross-site Fetch Metadata requests are rejected.
- `external` means the operator takes responsibility for the TLS boundary. Cookies are always `Secure; HttpOnly; SameSite=Strict` in this mode even though Traefik-to-app HTTP is plaintext. The app never infers trust from arbitrary `Forwarded`, `X-Forwarded-Proto`, `X-Forwarded-Host` or `X-Forwarded-For` headers. Spoofing these headers does not change cookie security, request admission or client identity.
- Local source development defaults to loopback, a port-exact loopback Host check, socket-based Secure cookies, and `local-open` profiles/registration. First-local-guest seed ownership remains a local convenience only. Do not expose local mode through a proxy.

## Offline account provisioning

Run the commands below yourself, as the new service's UID and against **only its dedicated database**, while that service is stopped. Do not run them in the existing Universe dev container. With an image, use a one-off container from the same image with only the new data volume mounted, no published port and preferably no network. The application process is not running during provisioning; this is not a web bootstrap endpoint.

The operator chooses each unique password. These commands do not generate one, email one, create API keys or mint service tokens. Do not put passwords in command arguments, environment variables, shell history, scripts, source control, logs, screenshots or this document.

### 1. Create the initial owner exactly once

```sh
UNIVERSE_DB=/data/universe.sqlite node scripts/operator-account.mjs bootstrap-owner
```

In an interactive terminal, the CLI asks for display name, lowercase username and a hidden password twice. Passwords must contain 16–256 characters, with no outer whitespace or control characters. The account uses the application's salted scrypt hash format. New SQLite files and sidecars use an owner-only umask. Keep the containing volume private as well.

The command initializes the normal seeds if necessary and atomically claims them for this explicitly created account. It refuses a prior bootstrap, any existing profile/account/session, or any existing ownership. It will not silently convert a first local guest into the public operator. A failed fresh public startup may have created only the empty seeded database; that is still safe to bootstrap. Never delete existing data to force this command through; investigate a refusal.

The public server refuses to start until the operator marker points to a real account, that account owns a universe, all seeded place ownership is claimed, and there are no unprovisioned guest profiles. There is no Internet-accessible first-owner race. Bootstrap cannot be repeated to replace the owner.

### 2. Add each approved reviewer

```sh
UNIVERSE_DB=/data/universe.sqlite node scripts/operator-account.mjs add-reviewer
```

This prompts for a separate account in the same way. It requires a valid existing bootstrap, refuses duplicate usernames and creates an ordinary identity with **no ownership, role elevation or durable membership**. Once signed in, a reviewer can visit public places as a guest role. The operator owner must explicitly use the existing membership/invitation tools for private places or editor/admin permissions. An account and a world membership are separate concepts.

For non-interactive provisioning, stdin may contain one JSON object with only `name`, `username` and `password`, bounded to 8192 bytes. Supply it through the operator's approved secret-input mechanism, not `echo` with a password in a command. The CLI reports only the account username and outcome. It creates no authenticated session and has no reset/recovery/SSO flow. Distribute credentials through an already approved private channel; this handoff does not authorize sending them anywhere.

### 3. Start only the new service

After the offline commands succeed, start one instance using the explicit configuration above and its dedicated volume. Check its health privately before enabling reviewer access. Do not run the bootstrap command automatically at every container start or keep owner passwords in container environment variables.

## Health, proxy and live-state behavior

The Docker health check runs `node scripts/healthcheck.mjs`. It connects to the local application listener with the configured allowed Host and checks `GET /api/health`; it does not bypass Host validation or require a login. Its success proves only that the app process responds, not that external DNS/TLS/media work. Verify those separately through the actual route.

The app uses SSE (`/api/events`) with 15-second heartbeats. Disable response buffering for this route, preserve streaming, and allow appropriate idle/read timeouts. Check disconnect/reconnect and revocation rather than merely loading the landing page. Native request body/time limits and session checks remain active.

Login and guest rate limits currently key on the actual socket peer. Behind a reverse proxy, they can aggregate reviewers under the proxy address. Do not fix that by blindly trusting `X-Forwarded-For`; agree and implement a separately tested trusted-proxy/client-identity policy if aggregate limits impede the small preview. Load, brute-force protection, total database/upload quotas and disk-exhaustion behavior need operator assessment. No production capacity, penetration-test or abuse-resistance certification is claimed.

## Required acceptance tests

Use synthetic accounts and test-only content on the dedicated preview. Never probe the existing dev application's data or reuse its credentials.

1. Confirm an empty/unbootstrapped public instance fails closed. Confirm startup rejects open registration, missing or wildcard lists, insecure Origins and incorrect TLS/cookie settings.
2. Confirm correct DNS and a valid external HTTPS certificate. Verify no host port is exposed and unauthorized hosts cannot reach the app. Test forged Host/Origin and forwarded headers through the real proxy; ensure the proxy is not rewriting a rejected host into the allowed one for arbitrary routes.
3. Confirm the welcome screen permits login only, unauthenticated `POST /api/session` cannot create a profile and `POST /api/account` cannot register even for an authenticated reviewer. Wrong passwords must fail. Inspect login and logout cookies for `Secure`, `HttpOnly` and `SameSite=Strict`.
4. Use independent browser profiles for the operator and two reviewers. Confirm the operator alone owns the seeded hierarchy; reviewers have no implicit editor/admin role. Check private discovery, invitations, personal-area boundaries and immediate membership revocation with an open SSE connection.
5. Save a harmless scene edit and message, stop/restart only this preview, and verify persistence. Test SSE reconnect and restore from an isolated copy of a consistent backup. SQLite/WAL backups must use an approved consistent snapshot/backup procedure or a cleanly stopped service; copying only a live main `.sqlite` file can omit committed WAL data.
6. Check actual microphone/camera permission UX, independent network clients, TURN traversal, real audio/video packets and physical-phone behavior. These are still unverified release gates. The cloud/headless browser test is not evidence of real media success.
7. Observe CPU, memory, open descriptors, log volume, DB growth and proxy error rates during the intended small-reviewer workload; verify the existing Universe dev service remains healthy throughout.

## LiveKit/TURN reuse is later adapter work

This hardening change configures no LiveKit, TURN, SFU or broadcast credential and mints no provider token. The current direct-peer signaling implementation is not a ready LiveKit adapter. Existing infrastructure reuse requires a separately reviewed server-side token issuer, participant authorization, publish/subscribe policy, lifecycle cleanup, capacity and cross-network tests.

Room-name prefixes and a second API key on one broadly privileged LiveKit project are **not cryptographic tenant isolation**. Determine actual provider-side capability boundaries and any need for independent project/instance isolation before transmitting service credentials. Do not reuse production room names or broad administrative secrets. No new paid media service is authorized here.

## Isolated rollback and records

Record the new service/image digest, reviewed source revision, dedicated volume name, route name, configuration (without secrets), backup location and acceptance results. To roll back, disable only the new hostname route and stop/remove only the new standalone service, retaining a consistent snapshot of its data. Verify existing Universe dev health after rollback. Do not remove shared proxy networks, certificate stores, media services or existing dev volumes.

The Dockerfile/CLI/unit checks are source-level readiness work. An image build/run, real proxy routing, public HTTPS, resource capacity, backup restore and cross-network media must each be marked passed, failed or unrun by the operator; an unrun item is not a successful deployment.
