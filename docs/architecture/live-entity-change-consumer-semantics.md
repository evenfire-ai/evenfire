# Live entity-change consumer semantics

Live entity-change delivery is a latest-state convergence signal, not event-history playback.
Healthy clients should converge to authoritative state within approximately five seconds; clients
may coalesce intermediate changes while disconnected or under load.

Two transports carry these signals. Control UI consumes the operator entity-change stream. Desktop
consumes the per-user GFS watch: main keeps one watch stream per session, each window tells main
which resources it shows, and main forwards keyed events to every window. The Desktop column below
describes the window's reaction to those events; the stream's transport rules (heartbeat watchdog,
backoff, session guards) live in main's watch client.

| Input | Desktop (GFS watch) | Control UI (operator stream) | Required visible result |
| --- | --- | --- | --- |
| `heartbeat` | Main only: rearms the stream watchdog. Never reaches a window. | Update transport liveness only. | No query, list, selection, dialog, or preview mutation. |
| Silent/half-open stream | Main closes the stream after three missed heartbeat intervals and reopens it with bounded backoff; the reopen re-covers every watched key. | Abort after 130 seconds without a validated server frame, then use bounded reconnect/backoff. | Watchdog is transport-only; expiry never invalidates entity state. |
| Resource change | `changed` for the exact keys written. A file key re-resolves the open preview through the same path as a user refresh; a folder key re-reads that folder's listings, and re-resolves the location when it is the open Files folder. | `scope.invalidated`: coalesce a bounded burst into one active and one trailing authoritative pass. | Keep loaded pages and preview bytes until authoritative reads establish a change or denial. |
| User navigation or pagination during refresh | A folder refresh joins an in-flight read instead of cancelling it, then runs one final pass. Per key, at most one refresh runs and one more is kept. | Bind results to location, operation, cursor, and generation. Defer a pending scope refresh across load-more. | A stale page never appears in another folder; the pending refresh eventually runs. |
| Stream (re)opened or key newly covered | `resync` for keys whose changes the window may have missed; same reaction as `changed`. | `resync_required`: reconcile mounted, open, cached, and visible operator scope. | Purge anything the authoritative reads deny. |
| Refused key | `rejected`: same reaction as `changed`; the authoritative resolve applies the 403/404. | N/A | The resource shows the generic unavailable state. |
| Access may have changed | `accessChanged`, on every stream ready and when the server closes the stream to reauthorize: re-read roots and open sharing dialogs (grants, shares, inherited access, affordances) at once, and mark folder listings stale without reading them, so an unwatched folder re-reads when shown again. Watched keys are not re-resolved here: after a reauthorize close, watched previews and folders converge (a 403 lands as unavailable) with the `resync` of the next ready, which comes once main reopens after the wait the server's `Retry-After` sets. | Follow the operator authorization refresh. | Roots and dialogs reflect the change at once; watched resources converge on the next ready; unchanged state is preserved. |
| Accessible roots changed | `accessChangedRoots`: re-read the roots listing only. | N/A | Roots converge; nothing else refetches. |
| `stream.closing` (lifetime, listener loss, shutdown) | Main reopens with bounded backoff; the next ready emits `accessChanged` and `resync`. | Reconnect with bounded backoff. | A healthy close does not clear visible state. |
| Session expired / HTTP 401 | `sessionExpired`: purge every GFS query, mark every open preview unavailable and revoke GFS access for the session, whether or not anything is mounted; every Files view drops its open location and its names. A window that registers after the expiry learns it from its registration answer. Main reopens only with a newer committed session. | Follow the existing unauthorized-session path and stop the expired stream. | No dead subscriber or stale authorized bytes remain. |
| Connect failure or rejected frame | Main preserves the windows' state and honors retry guidance. | Preserve visible state and use bounded backoff. | No destructive invalidation or hot retry loop. |
| Background read failure | Keep the last visible state and retry background work only. | Keep the last visible state; do not use navigation or pagination clearing paths. | Rows, dialogs, selection, and user-visible errors remain intact. |
| Deletion or revocation | Purge affected bytes/object URLs and show the generic unavailable state. | Remove the affected resource and close only actions bound to it. | No inaccessible content remains; unrelated state is preserved. |
| Root hierarchy refresh | Treat `/` as a valid root with no ancestors. | Treat `/` as a valid root with no ancestors. | No false hierarchy-recovery warning at the root. |
| Main-frame navigation or renderer loss | Main empties that window's list and keeps it registered; the new document registers again when it mounts. | N/A | A dead or replaced document never keeps resources watched. |
| Temporary team-context transition | Main keeps the stream bound to the committed session; an expiry inside the transition is deferred until it ends. | N/A | A transient token is never sent to the stream endpoint. |

## Desktop watch list

- A window watches what it shows, in priority order: the active preview, the plugin preview
  overlay, the active Files tab's location (as a file or a folder, by what it resolved to), and the
  folders expanded and rendered in the sidebar tree in screen order. The list is cut at main's per-stream cap (64 keys), dropping the lowest priority.
- Keys are canonical `file:`/`dir:` keys built with the gfs:// resolver grammar. A by-path URI
  without a resource id is not watched until it resolves to one that carries the id.
- The list is derived from React state and sent after it settles for 150 ms. Identical lists are
  not re-sent, except after a session, principal, team or environment change: main empties every
  window's list on those transitions, so the next list is sent even when it did not change.
- Every list carries `me.id` of the user it was derived for; main drops a list of another user.
- A window registers on mount even with an empty list, so session and access events reach it.
- Leaving the list does not cancel an in-flight refresh of a still-open preview: the result still
  applies to its tab. Only closing the tab retires its pending refreshes and retries.

## Ordering and recovery invariants

- A response is current only for the resource identity, operation purpose, cursor, and generation
  that initiated it.
- Foreground navigation and pagination may supersede background work. Background work never
  cancels user work; pagination does not discard a queued scope refresh.
- Repeated invalidations coalesce, but a maximum wait bounds the delay before a trailing pass.
- An unchanged authoritative preview retains its identity and bytes. A relevant version, content,
  or metadata change uses the same generic preview reload boundary for every preview type.
- Transient failures never prove revocation. Only authoritative deletion or 403/404 purges the
  affected resource; an independently readable leaf remains open while denied ancestors are
  removed from its breadcrumb. Session-wide 401 follows the authentication-expiry path.
- Unknown or malformed frames are non-destructive and do not reset reconnect backoff.
- User event delivery must not disclose unauthorized resource identity or change timing.

## Scope

The contract applies to GFS consumers and is reusable for future entity types. Shared File System
(SFS) is explicitly outside this feature's scope.
