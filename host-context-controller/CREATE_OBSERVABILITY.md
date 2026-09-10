# HCC create and existence-read metrics

The read-first stage of [issue #598](https://github.com/evenfire-ai/evenfire/issues/598)
uses `ensureResource` at 22 create expressions. Existing resources retain their
convergence or preservation policies. The runtime Secret and safety-inventory
NetworkPolicy writer remain exempt; all 24 create expressions are instrumented.
Only an observed absence permits a new POST.

## Counters

Both counters use the existing HCC Prometheus registry and the bounded labels
`kind` and `outcome`. The kind inventory is NetworkPolicy, Service, Deployment,
ConfigMap, PersistentVolumeClaim, ServiceAccount, Role, RoleBinding,
PodDisruptionBudget, and Secret. No resource names, namespaces, user identifiers,
request bodies, or exception messages become metric labels.

| Counter                            | Outcome    | Meaning                                                                                                               |
| ---------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `clerum_hcc_creates_total`         | `created`  | The create callback resolved successfully.                                                                            |
|                                    | `conflict` | The create callback rejected with HTTP 409.                                                                           |
|                                    | `error`    | The create callback rejected for any other reason, including 403, 5xx, network errors, or synchronous client failure. |
|                                    | `skipped`  | One successful presence-based suppression of POST; excludes errors, cancellation, retries and attempted POST409.      |
| `clerum_hcc_existence_reads_total` | `found`    | An instrumented existence read resolved successfully; its result is not validated or altered.                         |
|                                    | `absent`   | An instrumented read rejected with HTTP 404; the original error still reaches the caller.                             |
|                                    | `error`    | An instrumented read rejected for any other reason, including HTTP 409.                                               |

Create outcomes are mutually exclusive and increment only after the callback
settles. The former `issued` series is removed. Summing `created + conflict + error`
counts completed attempts; `skipped` is not an invocation and is excluded from that
sum. Operations still in flight are not counted. A create resolving to null or
undefined still counts as resolved; telemetry does not assert object persistence. The same applies to
`found`: it reports a resolved read callback, not semantic presence, readiness,
or authorization correctness. Read `error` intentionally groups status and
transport failures for the instrumented paths; it cannot identify a 403 storm
or describe errors from excluded reads by itself. Diagnostics require separate
bounded evidence, without placing status messages or resource data in labels.

The bounded series are initialized at zero: 40 create series and 30 read series.
Re-importing metrics must preserve the registry and existing values. A zero series
alone is not proof that a path executed. For a single scoped environment:

```promql
sum by (kind) (increase(clerum_hcc_creates_total{outcome=~"created|conflict|error"}[5m]))
sum by (kind) (increase(clerum_hcc_creates_total{outcome="created"}[5m]))
sum by (kind) (increase(clerum_hcc_creates_total{outcome="conflict"}[5m]))
sum by (kind) (increase(clerum_hcc_creates_total{outcome="error"}[5m]))
```

Add the actual environment/target filters from the monitoring configuration.
These are client outcomes, not proof that every operation reached the API server;
a lost response can reject even if the server created an object. Validate server
outcomes and resource/business state separately when that distinction matters.

**Accepted trade-off:** if the process dies before a callback settles, that attempt
has no outcome sample. The previous pre-call increment could have been observed
before the crash. This loss is accepted in favor of an unambiguous partition;
server audit events can provide additional evidence for requests that reached the
server, but cannot reconstruct every client invocation. No crash-loss rate is
claimed or measured here. This contract is changed before downstream dashboards
and the read-first acceptance depend on it.

`observeCreate` and `observeExistenceRead` invoke their callbacks once and preserve
the returned value or rejected value. They do not swallow a 404, turn it into
`null`, retry a failed request, or convert an error into a create. Existing caller
catch behavior remains responsible for those decisions. Synchronous failures
count as `error` when the wrapper catches them; the original rejection is retained.

## Coverage

All 24 production `createNamespaced*` expressions are observed, including the
already-read-first Secret and the safety-inventory NetworkPolicy writer. Their
exemption from conversion does not exempt them from measurement.

The 26 instrumented existence-read expressions are:

| File                                | Read paths                                                                                                             | Expressions |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------: |
| `src/utils.ts`                      | Shared NetworkPolicy conflict convergence                                                                              |           1 |
| `src/hostReconciler.ts`             | ServiceAccount, Role, RoleBinding; runtime Secret; channel-reader Service/Deployment; PVC; Host Service and Deployment |           9 |
| `src/reconciler.ts`                 | ConfigMap, Deployment, Service conflict convergence                                                                    |           3 |
| `src/llmHookReconciler.ts`          | Deployment, Service, NetworkPolicy conflict convergence                                                                |           3 |
| `src/sharedFileSystemReconciler.ts` | PVC, Deployment and Service presence/convergence                                                                       |           3 |
| `src/k8s/gfsK8sApi.ts`              | PVC/Service presence; Deployment update check/convergence; PDB convergence                                             |           5 |
| `src/networkPolicyReconciler.ts`    | Fresh external-egress observation; safety-create conflict convergence                                                  |           2 |

Counts refer to source expressions, not requests per reconciliation. Retry paths
can execute more than once. The fresh external-egress helper has several callers;
all invocations are counted, including checks where no later write is necessary.

This is not a counter of all HCC reads. LISTs, reads of input objects used to build
a desired spec, readiness checks, scale-only operations, and safety replace/delete
paths unrelated to a create decision are excluded. An already-available snapshot
does not represent another API read. The inventory must be updated when a writer
or its read path changes; do not instrument both the API call and its retry wrapper.

The read-inventory test scans all production TypeScript under `src` for direct
dot-property `readNamespaced*`/`readCluster*` calls. Each must be observed or match an explicit
exclusion keyed by file, enclosing operation and SDK method, with an expected
expression count and reason. It currently accounts for 26 observed expressions
and 43 excluded ones. New unclassified reads and stale exclusions fail the test.
The plan's forecast of 27 reads became 26: 21 original expressions plus six new
ones minus the duplicate channel-reader Deployment expression. That retry now
uses the helper's validated read callback; no retry path was removed.
This is structural coverage, not execution evidence: changed purpose inside an
excluded operation still needs review, and computed-property or indirect/aliased calls are outside this
static-analysis guarantee. The behavioral tests and deployed validation
remain separate; an AST pass does not prove all those paths ran.

## Read-first contract

`existing === undefined` requires an instrumented GET; `existing === null` is a
caller-observed absence. A present snapshot is consumed once and is not another
GET. A read resolving without `metadata.name` is a contract error, never absence.
POST409 discards the absence and converges through real reads. The existing
replace loop owns validation, desired-body resolution, merge, no-op, mutation
fences and the original retry budget. Its 404 disappearance policy is distinct
from the initial GET404 that permits creation.

SDK callbacks remain instrumented at their sites. `onSkipped` retains the
literal kind there and increments once only after successful presence-based
convergence/preservation. Failed or cancelled paths do not count as skipped;
neither do retries or a POST409 already emitted. A caller preserving an existing
non-throwing convergence failure returns `false` to avoid reporting a skip.

`skipped` means a create was suppressed because the resource was present, not
that reconciliation was a no-op: convergence may still issue a separately
instrumented replace. A POST409 race counts as `conflict`, never another `skipped`.

Host ServiceAccount, Role and RoleBinding propagate unexpected read, create and
convergence failures to the existing reconciliation error handler. The new GET
never turns 403/transport failures into absence. Historical Host PVC/Service
create/update catches stay inside those callbacks, outside the initial GET;
supersession retains its separate error path. Preserved existing resources gain
no PUT or synthetic equality comparison. An unbound Host PVC retains its direct
update policy.

This RBAC propagation was explicitly approved on 2026-09-09 in the canonical
plan's Addendum C.3, which supersedes the earlier pending decision in B.5.
The bounded Role conflict retry was subsequently approved through the PR review
correction; it does not turn exhausted conflicts into successful provisioning.

Role convergence retries optimistic-lock conflicts through the shared bounded
retry helper (three attempts, fresh reads and admission checks). Exhausted
conflicts and unexpected RBAC errors still propagate; they are not successful
provisioning. Role replaces and no-op decisions now use the helper's write
metrics. Operators should expect previously silent RBAC failures to surface in
reconciliation error telemetry.

External-egress passes its fresh object separately from the expected UID/RV
snapshot constraint. A conflict invalidates the consumed snapshot, not the
constraint. The safety exception retains its existing inventory-based behavior;
an `ext-egress-` name alone cannot attribute or excuse a residual conflict.

For stable, already-present resources, verify that POST is suppressed while
convergence and business state still occur. Separate legitimate new resources,
races and cold start. A lower create count alone does not establish causality;
`absent` does not guarantee a POST if the mutation fence expires afterward.

## Deployed acceptance and rollback

Evaluate each converted resource-kind lane in a stable five-minute window,
recording the exact image/producer identity, counter boundaries and audit window.
For resources proven present throughout that window, require zero redundant
create attempts and a positive witness that reconciliation and the intended
convergence/preservation actually ran. Assess cold start in a separate window;
classify legitimate new resources and races separately instead of treating all
creates as redundant. Report each lane rather than only an aggregate decrease.

Addendum C.4 supersedes B.7's blanket zero-create target and prefix exception.
In the NetworkPolicy lane, an `ext-egress-` name alone never exempts a conflict:
the shared helper and the safety-inventory exception can use that family. Explain
every residual conflict using evidence of the actual path and race/inventory
state. Counters alone cannot attribute a request to a resource name or call site.
These are acceptance criteria for the post-deployment measurement, not a claim
that this PR's local tests performed that measurement.

The rollback unit is PR 2 as a whole: restore the previously deployed HCC image
through the normal deployment/rollback process. Stages A–D are review order,
not independent rollback units; do not mix partial stage reversions or kind flags.
For a source revert, the accompanying regression tests revert with PR 2 as well.
Rolling back does not itself validate the restored runtime or its request load.

## Historical evidence and attribution limits

The historical aggregate `regimen-2026-09-09-agregado.csv` and its companion
BRIEF contain five-minute observations for `base1`, `base2`, `reg1`, `reg2`, and
`reg3`: respectively 1,684 / 1,833 / 1,669 / 1,171 / 2,107 HCC create conflicts.
The [measurement table in issue #598](https://github.com/evenfire-ai/evenfire/issues/598)
is the accessible published reference: its hourly rates are these observed
counts multiplied by 12. These are historical observations, not acceptance
thresholds, a performance benchmark, or validation of this candidate.

`reg3` is the third post-deployment observation window, 2026-09-09
08:30:00–08:35:00 UTC. A separate metadata-only re-query of that window returned
1,846 conflicts for the four selected kinds, below its 20,000-result cap:
NetworkPolicy 1,020; Service 389; Deployment 381; PVC 56. These exactly match
the archived aggregate for those kinds. The remaining 261 conflicts in the
all-kind total of 2,107 are ConfigMap 189 + ServiceAccount 22 + Role 22 +
RoleBinding 22 + PodDisruptionBudget 6; the selected-kind query did not include them.

| Kind          | Observed name-family counts                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| NetworkPolicy | `ctx-` 509; `rpc-egress-` 254; `wfc-` 56; `channel-reader-` 22; `gfsc-` 12; `llmhook-` 4; `ext-egress-` 12; other 151 |
| Deployment    | `channel-reader-` 20; `gfsc-` 6; `llmhook-` 4; `wfc-` 28; other 323                                                   |
| Service       | `channel-reader-` 20; `gfsc-` 6; `llmhook-` 4; `wfc-` 28; other 331                                                   |
| PVC           | other 56                                                                                                              |

These are prefix observations, not executed call-site traces. The classifier used
the literal `gfsc-` prefix, so the exact Service name `gfsc` belongs to `other`.
The PVC factories also fall outside the selected prefixes. Do not assign their
counts to a caller by subtraction.

Code maps the first five NetworkPolicy families to the shared apply helper (853
conflicts in total), but this is source-derived attribution. `ext-egress-` can
reach both that helper and the safety writer. Other names include additional
LlmHook policies. General Host/McpServer Service and Deployment names have no
mandatory prefix, so prefix matches alone do not exclude collisions. Namespace,
the relevant inventory, and writer provenance are needed before asserting a
unique site. Complete per-expression attribution remains unproven.

## Validating a deployment

Compare counter increments and audit events from the same exact half-open UTC
window, cluster, HCC identity, image/revision, and replica set. Account for process
restarts, scrape gaps, ingestion delay, and query truncation. Record successful
command exits and retained-row counts; missing data is unknown, not zero. Local
tests and a historical re-query do not replace simultaneous deployed validation.

For create conflicts, compare the `conflict` subset with the audit's conflict
result, not with all completed create outcomes. The audit uses `google.rpc.Code=10`,
which represents conflict, while client errors use HTTP 409. Historical audit
data did not contain GET records; no API-server read rate is inferred from that
absence. The read counter only covers the explicit inventory above.

No fixed GET-to-POST ratio is required: an existing POST409→GET path already
reads, whereas a create-and-ignore-conflict path does not. Read-first preserves
that distinction. This change does not demonstrate savings
in CPU, latency, admission cost, APF, or request volume.

The instrumentation prerequisite was delivered in [PR #599](https://github.com/evenfire-ai/evenfire/pull/599).
Its deployed observation is a baseline, not validation of the read-first
candidate. T0, T1, T2, CI, browser E2E and deployed measurements are separate
evidence lanes; see [the local runtime runbook](../docs/testing/minikube-t2-runbook.md).
