# Native proximity and Nearby text

`server.mjs` accepts one optional environment variable,
`UNIVERSE_PROXIMITY_CONFIG`, containing an explicit JSON object. This is a source
configuration contract. Absent configuration selects bounded native defaults described
in [guest conversations](docs/GUEST-CONVERSATIONS.md). No deployed settings,
capacity assessment or provisioning are inferred.

## Off, enabled, and disabled are distinct contracts

- **Variable absent:** native four-person bubbles and Nearby text are enabled.
  Device consent remains off. These defaults apply to public guests and accounts.
- **Explicit off:** use exactly
  `{"membership":{"enabled":false},"text":{"enabled":false}}`. The process
  again omits both factory options. A disabled feature may contain only
  `enabled:false`; remove stale policy fields when disabling it.
- **Membership only:** supply the complete membership object with `enabled:true`
  and `"text":{"enabled":false}`.
- **Membership and Nearby text:** supply the complete membership object with
  `enabled:true` and `"text":{"enabled":true}`. Text cannot be enabled alone.

Whenever the variable is present, both `membership` and `text` are required and
no other top-level keys are accepted. Blank text, `null`, `{}`, scalar values,
arrays, partial objects, unknown fields, duplicate JSON field names, and malformed
JSON fail startup. Boolean strings such as `"true"` are not booleans, and numeric
strings are not numbers. JSON does not permit comments or trailing commas.

The process validates the entire optional configuration before calling
`createGameServer`, opening/creating the database, seeding data, or binding a
socket. Errors identify the schema or authority rule without printing submitted
values, unknown field names, or the original JSON parse error. The reusable
`createGameServer` factory never reads this environment variable: callers still
pass validated `proximityMembershipConfig` and `proximityTextConfig` explicitly.
At that factory boundary, **omit** an option to turn it off; `{enabled:false}` is
an invalid enabled-factory configuration and is not passed through by the reader.

## Required membership policy

Every field below must be explicitly supplied for a custom enabled membership policy. All
numbers are JSON numbers. The bounds describe current validation, not recommended
operator settings. Obtain the actual policy, coordinate scale, limits and timings
for the intended environment before enabling it; do not copy test values.

| Field | Meaning and units | Validation |
| --- | --- | --- |
| `enabled` | Explicit all-member authority opt-in | Boolean `true` |
| `membershipCeiling` | Maximum accounts in one proximity bubble, including members with media off | Integer, at least 2 and no greater than `maxMembersPerRoom` |
| `p2pThreshold` | Member count above which the selection policy requires SFU rather than allowing the P2P mesh | Integer from 1 to 100000 |
| `downgradeDelayMs` | SFU-to-P2P selection debounce after relevant membership changes, in milliseconds | Nonnegative safe integer |
| `minimumDistanceSource` | Distance threshold for forming an initial nearby pair, in source coordinate units | Finite number at least `Number.EPSILON` |
| `groupRadiusSource` | Existing bubble joining and retention geometry radius, in source coordinate units | Finite number at least `Number.EPSILON` |
| `sourceUnitsPerWorldUnit` | Source coordinate units per standalone world unit; applied equally to both planar axes | Finite number at least `Number.EPSILON` |
| `coordinateLimitWorld` | Absolute accepted position bound on each planar axis, in standalone world units | Finite number at least `Number.EPSILON` |
| `memberTtlMs` | Presence lease used by membership authority, in milliseconds; reads do not renew it | Finite number at least `Number.EPSILON`, no greater than the existing 60000 ms presence lease |
| `maxRooms` | Authority room bound | Integer from 1 to 64 |
| `maxMembersPerRoom` | Account membership bound within one room | Integer from 1 to 256 |
| `maxAccounts` | Distinct account bound across the authority | Integer from 1 to 4096 |
| `maxMemberships` | Account-room membership bound across the authority | Integer from 1 to 8192 |
| `maxSessionsPerMember` | Live session bound for a single account in a room | Integer from 1 to 16 |

The existing authority validator additionally bounds each finite numeric input by
`Number.MAX_SAFE_INTEGER` and requires
`coordinateLimitWorld * sourceUnitsPerWorldUnit <= Number.MAX_SAFE_INTEGER / 4`.
The adapter selects its existing internal `source-threshold` meeting policy;
`meetingPolicy` is not an operator field. No geometry, transport, authority or
text-service rules are changed by the environment reader.

`text` has only the boolean `enabled` field. Text limits remain those of the
existing text service and cannot be overridden in this object. Nearby messages
remain ephemeral and scoped to current membership and the current event stream;
room chat remains a separate persistent channel.

## Supplying an operator-approved configuration

Provide the exact JSON as `UNIVERSE_PROXIMITY_CONFIG` through the operator's
existing process configuration mechanism. For a separately approved local run,
an operator may read an already prepared JSON file without editing the factory:

```sh
UNIVERSE_PROXIMITY_CONFIG="$(cat /path/to/operator-approved-proximity.json)" node server.mjs
```

The file path above is a placeholder. Changing the file alone does not alter an
already running process. This document neither applies settings nor starts,
restarts, provisions or publishes a deployment. It introduces no credential
fields; do not put ICE credentials or other secrets in this object.

For schema illustration only, the following is the **synthetic automated-test
fixture**. It is neither observed source/deployed configuration nor recommended
numeric defaults:

```json
{
  "membership": {
    "enabled": true,
    "membershipCeiling": 8,
    "p2pThreshold": 5,
    "downgradeDelayMs": 20000,
    "minimumDistanceSource": 64,
    "groupRadiusSource": 48,
    "sourceUnitsPerWorldUnit": 16,
    "coordinateLimitWorld": 100000,
    "memberTtlMs": 60000,
    "maxRooms": 8,
    "maxMembersPerRoom": 100,
    "maxAccounts": 200,
    "maxMemberships": 400,
    "maxSessionsPerMember": 8
  },
  "text": {"enabled": true}
}
```

## Existing deployment and media requirements

Host/Origin allowlists, public-mode login-only admission, offline account
provisioning, database location, external TLS, Secure cookies and ICE relay
configuration keep their existing paths and requirements. See
[DEV-PREVIEW-OPERATOR.md](DEV-PREVIEW-OPERATOR.md) and
[HOSTING-READINESS.md](HOSTING-READINESS.md).

Enabling membership or text grants no microphone, camera, screen-sharing or
per-session media consent. It does not implement or provision an SFU. Groups
above the configured P2P threshold remain blocked from an oversized media mesh
when SFU is unavailable; text can still operate for an eligible bubble. Synthetic
startup/HTTP/SSE tests do not prove real devices, relay allocation, AV delivery,
deployed capacity or full source parity.

Focused verification:

```sh
node --test tests/proximity-runtime-config.test.mjs tests/proximity-runtime-entry.test.mjs
```

These tests cover absent/off startup, membership-only and combined opt-in,
required fields and authority bounds, rejection before bind/storage creation,
an unchanged pre-existing synthetic database, ambient factory isolation and
non-disclosure of submitted values in errors.
