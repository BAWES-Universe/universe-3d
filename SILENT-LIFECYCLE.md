# Silent areas and native media lifecycle

Silent blocks outgoing microphone/camera/screen capture and incoming spatial calls. It wins over overlapping meeting/stage/audience areas, and mandatory policy copy cannot be replaced by an old custom area message. Persistent room chat, Express and authored ambient audio are separate features; the UI does not claim they are muted.

An unjoined user cannot Join or Retry inside Silent. Existing opt-in is retained so the user can explicitly Leave, and eligible listening may resume after exit; device capture never resumes automatically. A browser capture prompt cannot be programmatically cancelled, so its eventual stream is stopped and discarded if denial occurred in the meantime. A later deliberate request owns its own token; old completions/errors cannot stop or overwrite it.

## Corrected races

- A same-room HTTP policy request started before a newer pushed policy cannot overwrite that accepted policy on late completion. Old errors and finalizers cannot clobber a newer request
- Every publishing-denial transition invalidates pending capture as well as active streams. Entering and leaving Silent does not revive an earlier permission prompt
- Room/account changes invalidate client work; wrong-room or known wrong-user policy is rejected. All native signaling still rechecks the current server graph

- Received committed Silent geometry immediately stops active and acquired-pending streams, invalidates unresolved capture tokens and retires transport; editor drafts are excluded
- Policy GETs have an 8-second monotonic deadline and AbortSignal; adapters ignoring abort are retired. Exit requires a new authoritative response before eligible listening can resume
- Delayed SDP and track work checks current actor, room, recipient and peer ownership before continuing

## Exact limits

Event-loop suspension may delay the timeout callback; overdue results fail closed on resumption. Geometry is limited to received committed snapshots. A server room-revision rollback remains conservatively denied until reload or lifecycle reset. Client acceptance epochs fix the demonstrated HTTP-versus-push race. The service still lacks an authoritative policy boot/scope/revision protocol spanning replaced SSE connections and same-user/same-room session reincarnations. This patch does not certify all possible cross-channel stale ordering. It also does not make self-hosted LiveKit JWTs revocable or connect an external SFU/TURN service.

Source runtime semantics were audited against game PR599 at f7e05036ef2c290155814a64c9f282fb54dcf9f7; the observed later01dfafd change was documentation-only. That audit did not establish an upstream deployment. The existing candidate server already denied Silent graph/signaling; the reproduced gaps were client ordering, capture lifecycle and copy, not a demonstrated media leak.

## Verification

`npm test` includes controlled pending-success/error, denial/exit, replacement request, stale GET/push/error/finalizer, actor/room, overlap and copy regressions. `npm run test:browser:media` runs five serial suites:

1. GPU-free controlled DOM with capture prohibited, at desktop/landscape/320px widths
2. Native browser permission-denial and lifecycle behavior
3. Two real cookie sessions with native SDP over authorized SSE; teardown on Silent and room exit, stage/audience directions
4. Actual3D click-to-walk into/out of overlapping areas, actual banner and Connect controls, no automatic capture/join
5. Actual-world held-policy and delayed-presence scenarios with controlled fake tracks, immediate Silent entry stop and fresh-policy exit

Synthetic policies are identified as fixtures. No successful camera/microphone/screen packets, physical phone, TURN path, external provider or production test is claimed. The full-world fixture creates fresh local data and prohibits capture. Current-source unit count is396, not a feature-completion metric.
