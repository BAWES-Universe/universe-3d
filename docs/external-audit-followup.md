# Independent audit follow-up

The friends-preview and feel/performance reports dated 3 October 2026 audited
`f534ad2b19bc6cda9cb64b0f7e567930d724810b`. This follow-up starts from the later
development tree `b349974d45ffc494f7157045547431f74d5126ff` (published as
`92fc8b6b516d631162df683e3f8dffe6d46b720d`). Report findings are hypotheses about
that later code until reproduced. Neither report certifies a deployed host,
physical phones, working internet calls, capacity or complete source parity.

## Confirmed fixes in this increment

- Friends F1: after a destroyed SSE connection misses revocation, a fresh
  authoritative session with no current room now retires the whole room UI,
  closes/disables Build and offers an exact draft download plus accessible
  places. Definitive reconnect denials share that cleanup; temporary failures
  remain unconfirmed rather than being called revocation. Delayed old shell
  catalog and Places responses cannot restore private names. Nine actual-game
  missed-event checks and nine connected-revocation checks pass, including
  native export. All four ordinary retained-reconnect/Silent checks also pass;
  the repair keeps dirty Build, iframe forms, focus and live media policy intact.
- Friends F3: removed an out-of-scope `child` reference that prevented a
  nonempty legacy-grant queue from rendering Members & invitations. The
  regression fails on the preceding code and passes after the one-line fix.
  Seventeen actual Places browser checks use the real HTTP/SQLite service,
  including private siblings and unrelated private worlds. Review and pending
  invitations grant no access; explicit add/accept remains world-scoped and
  does not turn a member into an editor. Existing hierarchy/migration tests
  also pass. No backend permission rule changed.
- Feel 6: the world canvas now shows an inset white focus outline when native
  keyboard navigation gives it focus.
- Feel 10: explicitly opening desktop Chat focuses its composer; touch opens
  on a non-text Chat control, so typing starts only after choosing the input.
  Live message/presence rendering does not independently transfer focus.
  Five full-game input checks cover the focus ring, immediate WASD typing,
  intentional return to movement, the C shortcut with its retained draft and
  touch composer selection. All eighteen existing social browser checks pass.

## Remaining work and boundaries

- Friends F2: whole-scene compare-and-swap still conflicts for disjoint edits.
  [The collaborative-editing plan](collaborative-editing-plan.md) specifies
  durable operation receipts, fresh validation, replay and conflict review.
  It is not implemented by these audit fixes.
- Friends F4: archiving retains the immutable image definitions/bytes used by
  placed objects and continues to count against retained quotas. No permanent
  deletion or storage-reclamation workflow is added here.
- Friends F5: the parity inventory is intentionally pinned historical
  evidence. Newer behavior must be checked in its relevant implementation and
  test records; its old row statuses are not an exact-head feature dashboard.
- Feel 1, 2 and 7: current native-input reproduction confirms short-landscape
  sheet overlap, Water triggering Done, a 24px inspector body and undiscoverable
  horizontal tools. The responsive editor repair is a separate increment.
- Feel 3: actual old buffers at 320x568 are 320x568 at DPR1, 240x426 at DPR2 and
  160x284 at DPR3. A bounded CSS-resolution policy is being verified separately;
  a picking pass does not establish adequate rendering resolution.
- Feel 4 and 5: current HTTP still sends the main bundle uncompressed with no
  validator; conditional repeats return a full 200 body. Compression/cache
  changes are a separate static-only delivery increment.
- Feel 8: scalable creator text and complete small-screen scrolling need
  separate verification. CSS enlargement is not physical OS text-scaling or
  accessibility certification.
- Feel 9: editor glyph replacement should reuse the established SVG family
  while preserving accessible labels and native keyboard activation. This is
  visual consistency work, separate from responsive hit-target correctness.

The operator release candidate remains independently pinned to `76b83c34`.
Source publication and local tests do not change a running deployment.
