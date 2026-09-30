# Live entity-change consumer semantics

Live entity-change delivery is a latest-state convergence signal, not event-history playback.
Healthy clients should converge to authoritative state within approximately five seconds; clients
may coalesce intermediate changes while disconnected or under load.

| Input | Desktop | Control UI | Required visible result |
| --- | --- | --- | --- |
| `heartbeat` | Update transport liveness only. | Update transport liveness only. | No query, list, selection, dialog, or preview mutation. |
| Silent/half-open stream | Abort an idle connection after 130 seconds without a validated server frame, then use bounded reconnect/backoff. | Use the same established 130-second operator watchdog. | Watchdog is transport-only; synthetic open does not reset it and expiry never invalidates entity state. |
| User `scope.invalidated` | Softly revalidate active GFS state and open resources. | Use soft semantics if received. | Keep loaded pages and preview bytes until authoritative reads establish a change or denial. |
| Operator `scope.invalidated` | Use the soft path if received. | Coalesce a bounded burst into one active and one trailing authoritative pass. | Preserve rows, selection, dialogs, errors, and unchanged previews while reads run. |
| User navigation or pagination during refresh | Foreground work wins; background work cannot replace its destination. | Bind results to location, operation, cursor, and generation. Defer a pending scope refresh across load-more. | A stale page never appears in another folder; the pending refresh eventually runs. |
| `resync_required` | Cancel obsolete background work and revalidate roots, current location, open tabs, and relevant caches. | Reconcile mounted, open, cached, and visible operator scope. | Settle on the returned cursor; purge anything the authoritative reads deny. |
| `stream.closing` | Reconnect with bounded backoff. | Reconnect with bounded backoff. | A healthy max-lifetime close does not clear visible state. |
| `session_expired` / HTTP 401 | Purge state that cannot remain authorized; rebind only to a newer committed session. | Follow the existing unauthorized-session path and stop the expired stream. | No dead subscriber or stale authorized bytes remain. |
| Connect failure or rejected frame | Preserve visible state; honor retry guidance and reset backoff only after a valid supported frame. | Preserve visible state and use bounded backoff. | No destructive invalidation or hot retry loop. |
| Background read failure | Keep the last visible state and retry background work only. | Keep the last visible state; do not use navigation or pagination clearing paths. | Rows, dialogs, selection, and user-visible errors remain intact. |
| Actual resource change | Apply metadata only to the matching resource; reload bytes only when relevant metadata changed. | Update only the matching list, tree, cache, or preview. | Duplicate and older responses cannot regress the current view. |
| Deletion or revocation | Purge affected bytes/object URLs and show the generic unavailable state. | Remove the affected resource and close only actions bound to it. | No inaccessible content remains; unrelated state is preserved. |
| Root hierarchy refresh | Treat `/` as a valid root with no ancestors. | Treat `/` as a valid root with no ancestors. | No false hierarchy-recovery warning at the root. |
| Main-frame navigation | Release the renderer stream after a committed navigation, renderer loss, or destruction. | N/A | A cancelled or in-place navigation does not strand the current renderer. |
| Temporary team-context transition | Keep the long-lived stream bound to the committed session and environment. | N/A | A transient token is never sent to the stream endpoint. |

## Ordering and recovery invariants

- A response is current only for the resource identity, operation purpose, cursor, and generation
  that initiated it.
- Foreground navigation and pagination may supersede background work. Background work never
  cancels user work; pagination does not discard a queued scope refresh.
- Repeated invalidations coalesce, but a maximum wait bounds the delay before a trailing pass.
- An unchanged authoritative preview retains its identity and bytes. A relevant version, content,
  or metadata change uses the same generic preview reload boundary for every preview type.
- Transient failures never prove revocation. Only authoritative deletion or 403/404 purges the
  affected resource; session-wide 401 follows the authentication-expiry path.
- Unknown or malformed frames are non-destructive and do not reset reconnect backoff.
- User event delivery must not disclose unauthorized resource identity or change timing.

## Scope

The contract applies to GFS consumers and is reusable for future entity types. Shared File System
(SFS) is explicitly outside this feature's scope.
