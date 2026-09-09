# HCC create and existence-read metrics

This instrumentation supports [issue #598](https://github.com/evenfire-ai/evenfire/issues/598). It observes the existing reconciliation
paths; it does not introduce read-before-create, extra Kubernetes requests,
ownership rules, retries, or updates to resources currently left unchanged.

## Counters

Both counters use the existing HCC Prometheus registry and the bounded labels
`kind` and `outcome`. The kind inventory is NetworkPolicy, Service, Deployment,
ConfigMap, PersistentVolumeClaim, ServiceAccount, Role, RoleBinding,
PodDisruptionBudget, and Secret. No resource names, namespaces, user identifiers,
request bodies, or exception messages become metric labels.

| Counter                            | Outcome    | Meaning                                                                                                  |
| ---------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `clerum_hcc_creates_total`         | `issued`   | One invocation of a Kubernetes create operation, including failed attempts.                              |
|                                    | `conflict` | An issued create rejected with HTTP 409. This is a subset of `issued`, not an exclusive outcome.         |
|                                    | `skipped`  | Reserved for a future presence-based create suppression; remains zero in this instrumentation change.    |
| `clerum_hcc_existence_reads_total` | `found`    | An instrumented existence read resolved successfully. The wrapper does not validate or alter its result. |
|                                    | `absent`   | An instrumented read rejected with HTTP 404; the original error still reaches the caller.                |
|                                    | `error`    | An instrumented read rejected for any other reason, including HTTP 409.                                  |

The bounded series are initialized at zero. Re-importing metrics must preserve
the registry and existing values. A zero series alone is not proof that a path
executed. Do not sum create outcomes to calculate request count.

`issued - conflict` is **not successful creates**: it includes other failures
(403, 5xx, network errors) and operations that have not settled. Starts and
responses can also fall in different observation windows. A successful-create
count needs matching audit success events and resource/business evidence; this
counter does not supply it by subtraction.

Select the outcome explicitly in queries. For a single scoped environment:

```promql
sum by (kind) (increase(clerum_hcc_creates_total{outcome="issued"}[5m]))
sum by (kind) (increase(clerum_hcc_creates_total{outcome="conflict"}[5m]))
```

Add the actual environment/target filters from the monitoring configuration
before comparing a deployment. These queries report attempts and conflicts,
not successful creations or a count of all completed operations.

`observeCreate` and `observeExistenceRead` invoke their callbacks once and preserve
the returned value or rejected value. They do not swallow a 404, turn it into
`null`, retry a failed request, or convert an error into a create. Existing caller
catch behavior remains responsible for those decisions. Synchronous client
failures count as attempts/outcomes too, so these counters are client-operation
observations rather than proof that every attempt reached the API server.

## Coverage

All 24 production `createNamespaced*` expressions are observed, including the
already-read-first Secret and the safety-inventory NetworkPolicy writer. Their
exemption from future conversion does not exempt them from measurement.

The 21 instrumented existence-read expressions are:

| File                                | Read paths                                                                                                                     | Expressions |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------: |
| `src/utils.ts`                      | Shared NetworkPolicy conflict convergence                                                                                      |           1 |
| `src/hostReconciler.ts`             | Role; runtime Secret; channel-reader Service; channel-reader Deployment outer read and retry; PVC; Host Service and Deployment |           8 |
| `src/reconciler.ts`                 | ConfigMap, Deployment, Service conflict convergence                                                                            |           3 |
| `src/llmHookReconciler.ts`          | Deployment, Service, NetworkPolicy conflict convergence                                                                        |           3 |
| `src/sharedFileSystemReconciler.ts` | Deployment conflict convergence                                                                                                |           1 |
| `src/k8s/gfsK8sApi.ts`              | Deployment update check and conflict convergence; PDB conflict convergence                                                     |           3 |
| `src/networkPolicyReconciler.ts`    | Fresh external-egress observation; safety-create conflict convergence                                                          |           2 |

Counts refer to source expressions, not requests per reconciliation. Retry paths
can execute more than once. The fresh external-egress helper has several callers;
all invocations are counted, including checks where no later write is necessary.

This is not a counter of all HCC reads. LISTs, reads of input objects used to build
a desired spec, readiness checks, scale-only operations, and safety replace/delete
paths unrelated to a create decision are excluded. An already-available snapshot
does not represent another API read. The inventory must be updated when a writer
or its read path changes; do not instrument both the API call and its retry wrapper.

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
result, not with all issued operations. The audit uses `google.rpc.Code=10`,
which represents conflict, while client errors use HTTP 409. Historical audit
data did not contain GET records; no API-server read rate is inferred from that
absence. The read counter only covers the explicit inventory above.

No fixed GET-to-POST ratio is required: an existing POST409→GET path already
reads, whereas a create-and-ignore-conflict path does not. Future read-first
work must preserve that distinction. This change does not demonstrate savings
in CPU, latency, admission cost, APF, or request volume.

The next read-first PR remains dependent on deployment and validated measurement
of this instrumentation. T0, T1, T2, CI, and browser E2E are separate evidence
lanes; see [the local runtime runbook](../docs/testing/minikube-t2-runbook.md).
