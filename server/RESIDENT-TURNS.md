# Private resident test protocol

A standalone manager-only protocol and private Test panel. It does not connect an external AI provider or MCP service, collect credentials, or change deployment configuration.

## Activation

The normal application factory and process entrypoint configure no provider. Existing room residents remain silent. Only trusted code may pass `residentTurnOptions` to `createGameServer`:

```js
residentTurnOptions: {
  initializeJournal: true, // explicit host migration; omit on subsequent read-only attachment
  provider: {
    endpoint: 'http://127.0.0.1:PORT/v1/chat/completions',
    model: 'synthetic-local-model',
    timeoutMs: 5000
  },
  toolMask: {pause: false, resume: false, return: false}
}
```

The endpoint example needs a real numeric loopback port. Only exact HTTP literal `127.0.0.1` or `[::1]` endpoints with the `/v1/chat/completions` path are accepted. DNS aliases, credentials, query strings, fragments, alternate numeric addresses, redirects, retries and environment fallback are rejected. This is a bounded local chat-dialect test adapter, not a real provider rollout.

Use a file-backed host Store with WAL, FULL/EXTRA synchronous mode, foreign keys ON, query_only OFF, and busy_timeout no greater than 10000ms. The adapter borrows the exact Store.db, never opens another connection or retunes/closes the host. Outer BEGIN and SAVEPOINT are rejected. Initialization commits the journal and scope tables explicitly before provider attachment. An initialized journal may be attached without `provider` to inspect existing authorized receipts. `:memory:` and insufficient durability fail closed.

## Private HTTP API

All routes require an authenticated current room session and universe owner or world admin/editor authority. A room-only editor is not a manager. The saved bot must be enabled and `respondToPlayers:true`.

- POST `/api/rooms/:room/bots/:bot/turns`, exact body `{clientOperationId, revision, message}`
- GET `/api/rooms/:room/bots/:bot/turns/:operation`
- POST `/api/rooms/:room/bots/:bot/turns/:operation/cancel`, exact body `{}`

Every response envelope has `{operationId,roomId,botId,revision,status,result,duplicate,cancelRequested}`. operationId equals the supplied clientOperationId. Initial acceptance returns HTTP 202, `status:'pending'`, `result:null`. Pending duplicate requests return 202. GET/cancel and known terminal replay return 200. Reads and replays revalidate the same actor, session, room visit epoch, role and saved bot revision before releasing anything.

Terminal states are `completed`, `truncated`, `filtered`, `limited`, `uncertain`, `timeout`, `cancelled`, `revoked`, or `error`. Only completed results contain provider text. The receipt includes `{status,text,textTrust:'untrusted-provider-output',toolResults,usage,code?}`. No prompt, endpoint, raw envelope or raw provider error is returned. `usage` counts observed calls and only reports provider totals when all attempted calls included valid usage. A synthetic orphan/uncertain receipt contains no reconstructed execution history; its zero usage fields are placeholders, not proof that no effect occurred.

Use the exact same operation ID and body after a lost response, or GET the receipt. Changed messages, revisions, sessions or visits cannot reuse the operation ID. Accepted identities never expire or regenerate. Restarted pending work has no new execution owner and returns `uncertain` / `TURN_OUTCOME_UNKNOWN`. A failed or uncertain tool is never retried automatically.

A cancellation acknowledgement means a cancellation was requested for active work. Wait for a terminal receipt before describing the generation as stopped. Cancellation does not undo already accepted commands; those tool receipts remain visible even when a later model answer is filtered. Cancelling orphaned work returns uncertain and `cancelRequested:false` because the outcome cannot be established.

## Tool authority and limits

Saved `modelPermissions` default independently to `{pause:false,resume:false,return:false}`. The effective mask is the intersection of the trusted factory mask, saved modelPermissions, saved manual permissions, and current manager authority. Existing manual tool defaults and CRUD/draft semantics remain unchanged. Move is never a model tool.

Pause, resume and return use the same host command validation and `bot_operations` receipt path as manual controls. The command receipt commits before applying its runtime effect. An accepted command means accepted, never arrived. Model output, turns and receipts never enter room chat/SSE or quest credit. Only existing movement snapshots can change after an authorized command.

- 2000 message characters; 8192 private-instruction UTF-8 bytes for Test (longer saved configuration is preserved but Test rejects before acceptance)
- 8192 output bytes, 65536 response bytes, 32768 context bytes
- At most 3 provider calls and 3 tool calls per turn; 1024 output tokens requested per call
- One active turn per actor, four globally; six newly accepted attempts per actor/minute
- 10000 retained turn identities/bindings, without implicit eviction
- 1–30000ms explicit provider timeout per call; default 5000ms

Leave/rejoin, logout, role/access policy changes, archive, bot edits/deletion and server close invalidate or abort relevant running work. Reads and each effect also revalidate current authority. Revoked work may remain durably pending because storing a response without current authority is forbidden; it must never be auto-retried.

## Manager Test panel

Saved residents expose a private Test panel. Create is always explicit, and testing never implicitly saves or creates a resident. Unsaved changes, a disabled resident, Respond to players being off, missing management rights, or an unavailable adapter block new tests. Independent model-tool switches start off.

A new Test posts once. Pending results use bounded read-only polling (about once per second for 30 seconds). Client requests have a 10-second deadline; an unknown acknowledgement exposes Check receipt and Retry same test. Retry preserves the exact original operation ID, saved revision and message. It never silently creates a new generation. Cancellation stays requested until a terminal receipt confirms its outcome; accepted tools are still shown and are not described as undone.

Provider text is rendered literally, with no HTML or automatic links. Polling and stale responses are scoped to the current actor, room, resident and revision. Catalog/permission refresh preserves input focus and cursor; account/room/revision changes clear private text. The browser does not persist the prompt or output across reload. Closing/reloading clears the local receipt pointer, while the server journal retains admitted identities: a full historical-turn browser is not implemented. Forget local receipt explicitly does not cancel the server operation. Unknown-outcome usage placeholders are not displayed as measured counts.

## Verification boundaries

HTTP/protocol tests use synthetic local fixtures. Separate component and actual-game tests exercise real keyboard/click controls, private replies, a permitted local command, exact lost-response replay, focus retention and reload behavior. No actual AI model, external service, relay, provider secret or broad bot-server credential was used. Software-WebGL UI evidence does not establish physical-device performance. The output filter is a conservative lexical barrier, not a semantic confidentiality proof. Instructions that collide with mandatory receipt metadata reject before acceptance rather than creating an unpersistable receipt. Real-provider compatibility, policy behavior and user experience need their own explicitly authorized rollout and verification.
