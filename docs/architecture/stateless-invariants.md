# Stateless-Lifecycle Invariants

Enforceable guardrails distilled from the stateless-agents work (PR #735).
The eight stateless-lifecycle bugs found live on-branch (five in one E2E
round, plus three from the review/kaizen passes) collapse into **five
reusable anti-patterns**. Four of the five share one root cause: _a decision
made on evidence that had already aged between its producer and its
consumer._ Encode these as guardrails so the class does not reappear.

This doc is the "how to not reintroduce the class" companion to the
narrative in
[`docs/architecture/overview.md` §12 (Stateless Agents / Host Lifecycle)](overview.md#12-stateless-agents-host-lifecycle).

---

## How to enforce (applies to AP-1, AP-2, AP-3, AP-5)

Before any **state-mutating status write** in a controller/tracker path:

1. **Fresh-read-before-status-write.** Re-read the object from the API
   server (not the informer cache) immediately before the write that
   commits a lifecycle decision. The canonical helper is
   `StatelessLifecycleExecutor.readFreshHost()`
   (`host-context-controller/src/statelessLifecycleExecutor.ts:567`); every
   heartbeat core reads it before touching status (suspend `:640`,
   suspend-blocked publisher `:772`, draining `:854`, cancel-drain `:934`),
   and the reconcile-path replicas guard reads it before any Deployment
   scale derives (`resolveWakeBeforeScaleDown`, `:1382`).
2. **Gate the write with a `resourceVersion` precondition** where the
   platform supports it, so a concurrent flip loses instead of silently
   clobbering. When the write is a status subresource patch, remember it
   bumps `resourceVersion` and fires its own MODIFIED watch event — do not
   treat that self-echo as new work
   (`statelessLifecycleExecutor.ts:71`, `sharedFileSystemReconciler.ts:104`).
3. **On a fresh-read failure, keep the conservative verdict for that beat;
   never fall through to the cached optimistic one** (see AP-2's failure
   branch, `statelessLifecycleTracker.ts:453`).

---

## AP-1 — Decide on the freshest evidence at the commit point

**Rule.** A state-mutating status write must be decided on a value read
_at the commit point_, not on a snapshot captured earlier in the reconcile.
Never patch status from a cached CR snapshot that could have been overturned
between capture and write.

**Bug it came from.** A stale `drained` report suspended a Host that had
just served a turn — the suspend decision rode a snapshot older than the
activity that invalidated it (fix `88b456416`, drained-report superseded by
fresh activity; hardened by the fresh-read drained-pre-scale guard in
`8f1fff5c3`).

**Follow.** Re-read immediately before the write:

```ts
// statelessLifecycleExecutor.ts — FRESH GET guards against the CURRENT
// server-side status, not the snapshot the reconcile started with.
const fresh = await this.readFreshHost(host)
// ...decide suspend/scale from `fresh`, then write.
```

**Every state-mutating status writer recomputes both the guard AND the
written value from `fresh`:**

- `suspendHostFromHeartbeatCore` — writes `suspended` only when fresh is
  `draining`; the written `wakeHandledGeneration` comes from fresh. Fresh
  `draining` alone is NOT sufficient: an aged drain:true verdict can
  re-persist `draining` (the poller's `markHostDrainingFromHeartbeat`) after
  a wake already cancelled the drain and was handled — and with
  requested==handled nothing would revive the suspended Host. The commit
  therefore also carries an AP-1 generation EPOCH — the
  `wakeHandledGeneration` the tracker observed when it DECIDED the suspend —
  and no-ops when the fresh generation advanced past it
  (`phase=drained_report_stale reason=wake_handled_since`) or when a wake is
  pending in fresh (`reason=wake_pending`). The epoch, not "fresh state is
  active", is the discriminator: every normal suspension commits over
  `draining`. The commit also REPORTS its outcome to the tracker
  (`SuspendFromHeartbeatOutcome`): a `skipped_stale` commit makes the tracker
  answer the drained pod `drain:false`
  (`phase=drained_suspend_skipped_stale`) so the pod UN-FENCES — a stale skip
  must never leave the emitter fenced behind evidence the commit itself
  rejected. Only the idempotent fresh-`suspended` retry (and a landed
  commit) keeps answering `drain:true`.
- `markHostDrainingFromHeartbeatCore` — writes `draining` only when fresh is
  `active`; generation from fresh. Fresh `active` alone is NOT sufficient:
  `active` is exactly the state a just-handled wake produces, so an AGED
  drain:true verdict (decided before the wake, persisted after) would
  re-fence the woken pod — and its consumed wake (requested==handled)
  revives nothing, stranding any pending intake. The write therefore carries
  the SAME AP-1 generation EPOCH as the suspend commit — the
  `wakeHandledGeneration` the tracker observed when it DECIDED the drain,
  threaded through `HeartbeatVerdict.entryWakeHandledGeneration` and the
  poller's persist call — and no-ops when the fresh generation advanced past
  it (`phase=draining_write_stale reason=wake_handled_since`) or when a wake
  is pending in fresh (`reason=wake_pending`). This closes the aged-writer
  loop end to end: BOTH the write that fences a pod (`draining`) and the one
  that parks it (`suspended`) are epoch-guarded, and the drained answer
  (`drain:false` on a stale skip) un-fences instead of re-fencing.
- `markHostActiveFromHeartbeatCore` — cancel-drain to `active` only when fresh
  is `draining`; generation from fresh.
- `handleWakeFastPath` — the wake transition writer (the 10th costume). The
  cached `requested > handled` comparison only DISCOVERS a potentially-pending
  wake; the commit is re-decided from a FRESH read inside the D3 precondition
  callback: it recomputes the requested generation (fresh annotation) and
  `wakeHandledGeneration` (fresh lifecycle) and SKIPS — no write, no duplicate
  wake-phase logs — when the fresh generation is already handled (a sibling or
  a prior fast-path pass won). Otherwise it emits ONLY a targeted
  `/status/lifecycle` op with `{ state: 'active', wakeHandledGeneration:
<fresh requested> }` — never the previous whole-`/status` spread of the
  cached snapshot, which could resurrect stale `conditions`/`reason` over a
  hardened sibling's fresher write. The stale cached `reason` is dropped on
  the wake transition (mirroring `markHostActiveFromHeartbeatCore` and
  `resolveWakeBeforeScaleDown`; the change-only suspend-blocked publisher
  re-stamps a still-valid reason on the next heartbeat), and fresh
  `conditions` can no longer be clobbered because the targeted op never
  touches them. On a 409 the helper re-reads fresh and re-decides, so a
  racing writer's newer decision is respected instead of overwritten. The
  durable flip still happens FIRST (before the replicas=1 scale patch), and
  the path stays bounded: one fresh GET + one status write + one scale patch
  per wake event.
- `publishSuspendBlockedReasonCore` — the D8 suspend-blocked reason ANNOTATOR.
  It must NEVER change state, only stamp the reason on top of the CURRENT
  server-side state. It re-sources `state` + `wakeHandledGeneration` from
  `fresh` inside the D3 precondition callback and GUARDS: a fresh state that is
  no longer `active` (fresh `suspended`/`draining` — the Host is no longer being
  kept active/blocked) is a no-op, so a suspend/drain that landed underneath is
  never resurrected. It emits a targeted `/status/lifecycle` op (never a
  whole-`/status` spread) and re-evaluates its change-only reason short-circuit
  against fresh.
- `writeLifecycleStatusToCluster` — the reconcile-loop accepted/rejected
  writer. Its `assessment.lifecycle` is derived from the CACHED snapshot, and
  in the accepted path its `state`/`reason` are a pass-through ECHO of that
  snapshot. It is subject to AP-1 like the heartbeat cores even though the D3
  resourceVersion precondition passes trivially (the serialized per-host chain
  makes a fresh GET immediately before the PATCH always match the current
  resourceVersion) — the precondition proves nothing changed AFTER the fresh
  read, not that the DECIDED value is fresh. So inside the `build` callback it
  re-sources the ECHOED lifecycle from `fresh`: when the assessment's `state`
  EQUALS the cached snapshot's state it is an echo -> prefer fresh (a heartbeat
  suspend that landed since the snapshot is preserved; `wakeHandledGeneration`
  stays monotonic against fresh); when it DIFFERS the assessment INTENDED a
  transition (kill-switch/rejection forcing active, or a
  `resolveWakeBeforeScaleDown` wake transition) and that override wins.

**Avoid.** Deciding a suspend from the `host` argument the reconcile was
entered with, when a wake or a fresh turn may have flipped
`status.lifecycle` in between. In particular, never write a status VALUE
sourced from the pre-fresh-read snapshot (`assessment.lifecycle` verbatim) on
the strength of a resourceVersion precondition alone -- the precondition
guards ordering, not the freshness of the decided value.

---

## AP-2 — The informer cache discovers work, it never decides it

**Rule.** The informer cache is allowed to _trigger_ a reconcile (discovery)
but must never be the evidence a lifecycle _verdict_ is committed on. A
missed or coalesced watch event leaves the cache stale until the periodic
resync; a decision made on that stale entry is wrong for the whole resync
window.

**Bug it came from.** The tracker's `wakePending` read the informer cache;
a missed MODIFIED event left a stale pending/not-pending verdict, blocking
re-suspension (cost leak) or risking a suspend over a landed wake until the
5-minute resync (fix `cfa47ace1`; the symmetric grace-expiry path was fixed
in KZ-R1 `1b3c2b35a`).

**Follow.** Cache lookup discovers; a fresh read decides:

```ts
// statelessLifecycleTracker.ts:232  — cache lookup: DISCOVERY only.
/** Host CRD lookup from the informer cache (McpServerWatcher.getHost). */
// statelessLifecycleTracker.ts:421-457 — resolve the cached-pending verdict
// against a FRESH read before it gates a drain:
if (wakePending) {
  // The informer-cached Host can be STALE right here...
  const fresh = await this.readFreshHost(...)   // server-side truth
  if (/* wake generation already handled */) wakePending = false
}
```

**Avoid.** Committing `wakePending` (or any drain/suspend gate) straight from
`getHost()` cache state without the fresh-read resolution.

**Pod identity is evidence too.** "Never-seen podUid ⇒ newer pod" is the same
cache-shaped assumption and breaks on out-of-order replay: after an HCC
restart, a straggler beat of the OLD pod replayed after the new pod's first
beat would adopt the straggler as current and retire the LIVE pod — every
live beat discarded, lifecycle wedged until the straggler dies. Adoption of a
never-seen podUid over an existing current pod is tie-broken on the pods'
immutable `creationTimestamp`s (`resolvePodOrdering`,
`statelessLifecycleTracker.ts:620`): a strictly-older newcomer is itself
retired with a loud log; an unresolvable order (host unknown, lookup failure,
newcomer invisible) keeps the current pod and retires nobody.

---

## AP-3 — A timeout is valid evidence only if the actor is inside your clock

**Rule.** A timeout only proves inaction if the thing you are timing shares
your clock. If the grace/deadline window is shorter than the actor's own beat
interval, expiry proves nothing — the actor may simply not have reported yet.
Size any grace as `> actor_beat_interval` and make expiry **ack-aware**.

**Bug it came from.** Drain-grace (20 s) fired before the emitter's 30 s beat
could report the drain, so the grace killed a pod mid-turn and the client saw
a 504 (fix `e00b0baf5`, grace expiry is ack-aware).

**Follow.** Only force-suspend on expiry when the emitter actually acked the
drain or provably went silent; if beats kept flowing, re-arm:

```
// statelessLifecycleTracker.ts:36-47
// Drain-grace expiry is ACK-AWARE: after a `drain: true` verdict the grace
// only force-suspends when the emitter ACKED the drain (last beat reported
// 'draining'/'drained' but the drained report never landed) or went silent.
// If beats kept flowing the grace RE-ARMS instead of killing in-flight work.
```

**Silence must be attributed to the right actor.** "No beat since arming" is
read from bookkeeping that only successful polls feed — a control-api/poller
outage spanning the grace makes a LIVE, beating emitter look silent. The
expiry may treat silence as evidence against the EMITTER only when the feed
provably flowed across the window: the poller reports every fully-successful
poll (`HeartbeatPoller` → `noteSuccessfulPoll`,
`statelessLifecycleTracker.ts:335`), and an expiry that saw no successful
poll strictly after arming (and recent enough, within poll-interval × 2)
RE-ARMS with `phase=grace_rearmed reason=feed_outage` instead of
force-suspending. Feed health is part of the timeout's evidence, exactly as
the actor's beat interval is.

**The expiry's identity evidence ages across its own awaits.** The grace
callback re-validates — after its fresh read and immediately before
delegating the suspend — that the current pod is still the pod it armed for
and that no new grace was re-armed underneath
(`statelessLifecycleTracker.ts:780-795`); a pod replacement landing during
the await would otherwise force-suspend the live replacement pod on
misattributed silence (its beat bookkeeping was reset by the roll).

**Avoid.** A fixed grace shorter than `CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS`
that force-suspends purely on wall-clock expiry, ignoring whether the emitter
was ever in a position to report — or whether anything was in a position to
OBSERVE the emitter at all.

---

## AP-4 — Dedup on delivery identity, not a per-attempt id

**Rule.** Idempotency keys must be assigned to the **delivery**, not to each
**transport attempt**. A retry of the same logical delivery must carry the
_same_ id so the second arrival replays instead of re-executing (and its MCP
tool side-effects do not fire twice). Conversely, two genuinely distinct
sends must get _different_ ids even if their content is identical — so the
durable identity should be a **per-request nonce, not a content hash**.

**Bug it came from.** rpc-proxy re-forwarded an already-answered request 83 s
later with no `messageId`; mcp-host minted a fresh uuid and the queue
re-executed it, double-firing tool side-effects (fix `686c97630` delivery
dedup + `ff54367c2` wake-hold latch; the inert-on-wake-retry path was P1-1
`1b3c2b35a`).

**Follow.** Stamp one stable id per delivery and carry it across the retry:

```ts
// rpc-proxy stamps a stable messageId ONCE and reuses it across the wake
// retry (wake-and-hold-route.test.ts:114) so mcp-host dedups the retry;
// two distinct sends with identical content still get DIFFERENT ids
// (wake-and-hold-route.test.ts:143, "D1").
```

**Avoid.** Minting a new id per forward attempt (causes double-execution on
retry). **Residual to close:** the current stable id is
`sha256(sender|hostRef|threadId|content)` — a _content_ hash, so two truly
identical messages inside the dedup TTL replay rather than execute. The
correct long-term identity is a per-request nonce (e.g. a client-supplied
idempotency key from the desktop app), which distinguishes deliveries by
intent rather than by bytes.

---

## AP-5 — "Restart" is not "invalid"

**Rule.** A process restart is not evidence that its derived state is stale.
Reuse healthy derived state across a restart; re-mint (rotate, regenerate,
re-issue) only when a _new consumer will actually read_ the new value —
otherwise a restart needlessly churns the fleet and invalidates live state.

**Bug it came from.** Every HCC restart re-issued runtime tokens, which
rolled **every** stateless pod — killing in-flight turns and resetting the
idle anchor (fix `3f6381f0b`, reuse the healthy Secret, rotate only near
expiry). The same principle makes replicas **derived from `Host.status`** on
every reconcile, so a routine reconcile or HCC restart never resurrects a
suspended Host. The writer of that derivation is
`ensureDeployment`/`buildDeployment` (`hostReconciler.ts`), whose replicas
come from the reconcile assessment — and the assessment ECHOES the CACHED
reconcile payload, so the claim only actually holds because
`resolveWakeBeforeScaleDown` (`statelessLifecycleExecutor.ts:1382`) guards
EVERY stateless assessment with a fresh read at the commit point: a cached
`suspended` over a fresh `active` (wake fully handled, requested==handled)
keeps replicas=1 instead of killing the live pod; a cached `active` over a
fresh `suspended` keeps replicas=0 instead of resurrecting a suspended Host
with no wake; a fresh-read failure skips the Deployment scale for the whole
pass (loud log, the resync retries). Replicas are a function of FRESH state
whenever fresh and cache disagree — never of the event payload.

**Follow.** Reuse the HCC-owned Secret while a serving pod holds the tokens
in memory; rotate only inside the near-expiry window:

```ts
// hostReconciler.ts:642  — "Reuse is only safe for Secrets HCC itself wrote"
// hostReconciler.ts:686-694 — rotate ONLY when nowMs >= exp - rotateBeforeMs
//                              (reason: 'refresh_token_near_expiry')
// hostReconciler.ts:751-758 — reuse is safe precisely when a serving pod
//                             rotates tokens in memory (deploymentReady && replicas>=1).
```

**Avoid.** Unconditionally re-issuing credentials (or re-minting any derived
artifact) on startup, and deriving replica count from anything other than
the durable `Host.status.lifecycle` state.

## AP-6 — The spec plane needs the reader's version at the commit point

**Rule.** An admin write that replaces `spec` must carry the
`resourceVersion` of the read the HUMAN's edit was built from, and a
conflict must surface to that human — never be retried away with the same
stale payload. Platform-owned `clerum.io/*` annotation keys must survive
admin writes that did not explicitly touch them.

**Bug it came from.** `resourceService.updateResource` read the current
object ONLY to harvest the server's `resourceVersion` (and annotations),
replaced `spec` wholesale with the caller's payload, and on 409 re-read and
re-applied the SAME stale payload up to 3×, actively defeating optimistic
concurrency. Trace: operator opens the host edit form at T0; at T0+5m
someone enables `spec.lifecycle.stateless` via kubectl; the form saves at
T0+10m → the stale echo replaces `spec` → lifecycle silently stripped → HCC
kill-switch, zero signal. The sibling metadata bug: spreading
`current.annotations` then `body.annotations` REPLACED the whole map,
erasing the `clerum.io/wake-requested` projection (write-only per
`hostWakeService.ts`) whenever an admin PUT carried any annotations map.

**Follow.** Reader's-version precondition end-to-end:

- Control UI captures `metadata.resourceVersion` at form load — NOT from the
  pre-save re-fetch, which would only guard milliseconds instead of the
  human edit window (`control-ui/app/hosts/[name]/page.tsx`,
  `formResourceVersionRef`) — and sends it on PUT.
- `resourceService.updateResource` uses the caller-provided version as the
  replace precondition instead of overwriting it with the server's current
  one, and maps 409 to `K8sConflictError` with NO retry
  (`control-api/src/services/resourceService.ts`).
- The admin facade answers `409 {error:'conflict', reason:'resource_changed'}`
  so the UI can tell the operator to reload
  (`control-api/src/routes/admin/resources.ts`).
- Annotations are merged per key: platform-owned `clerum.io/*` keys present
  on the server survive unless the caller explicitly sets that exact key
  (`mergeAnnotationsForReplace`, applied by both `updateResource` and
  `mutateResource`).
- The spec-echo contract in
  `control-api/src/routes/admin/hostSpecValidation.ts` documents how the
  echo and the precondition compose: the echo preserves fields the form does
  not edit; the precondition rejects the echo when it is stale.

**Avoid.** Re-reading only to harvest a fresh `resourceVersion` for a stale
payload; retry loops around full replaces that carry client intent; spreads
that replace whole metadata maps a projection writer co-owns. Callers that
legitimately want last-write-wins (API-only automation) simply omit
`metadata.resourceVersion` — that legacy path is pinned by
`control-api/test/services.resourceService.test.ts`.
