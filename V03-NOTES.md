# v0.3: Own and administer places

This tranche targets source contract groups WORLD-02/03/04/05/06/07, ACCESS-04/06 and NAV-03. It does not certify those entire groups or unrelated source-stack parity.

## Coherent authority model

- Stable Universe → World → Room IDs, scoped slugs, metadata revision checks and idempotent create requests
- Universe owner controls universe/world metadata; world admin may create rooms; effective editor/admin capabilities govern room changes
- Explicit world-local roles/tags and targeted registered-local-account invitations
- Public visitors are guests with empty world tags. Walking into a public place does not create durable membership
- Private ancestors constrain child visibility and admission. Each recipient gets personalized room capabilities
- Archive/restore is reversible and disconnects occupants while archived. This is intentionally not irreversible deletion
- Account chooser is a manager-authorized, world-scoped invitation lookup with a minimum query
- Membership loss and hierarchy changes reconcile sessions, SSE, scene editing, files, quests and media
- Existing local DM participants retain their conversation history after leaving; new sends require eligible shared context

## Migration policy

v0.2 automatically inserted public room visitor rows. That historical row is not reliable evidence of an explicit grant. Migration therefore never silently promotes it into a world membership or a private-room grant.

Known private-world room-only grants also never become a world membership: that would expose sibling private rooms. They are retained as review-required records, with a manager-visible review flow. An owner must explicitly choose new world membership, understanding that it grants access to the world's private rooms. This can tighten old access; it is deliberate, documented and tested. Source scenes, messages, file bytes, users and revisions remain durable.

## Publication remains separate

The local runtime is one Node process with SQLite and live in-memory coordination. Its local first-visitor seed-owner bootstrap is not appropriate for an unrestricted public URL. A public preview needs a verified durable runtime, safe owner bootstrap or read-only seeds, request origin/host controls and explicit lifetime/storage limits. No static-only deployment may be described as the functioning multiplayer game.
