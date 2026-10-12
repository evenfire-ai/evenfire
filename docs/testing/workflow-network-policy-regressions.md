# Workflow NetworkPolicy regression contracts

PR #855 repeatedly repaired one caller while another caller changed the meaning
of the same state or deleted the same resource outside its owner. Finding-local
red/green and mutation checks were useful, but mocks of production consumers
left the scheduler, finalizer and cleanup boundaries untested.

The regression suites below exercise those boundaries. A focused test command
is validation evidence; a class check separately inventories every producer,
consumer and caller of the affected behavior.

## Marker ownership

The marker represents three independent observations: apply (`A`), run-lane
prune (`P`) and removal of the legacy internet policy (`L`).

| Writer                               | A         | P         | L        |
| ------------------------------------ | --------- | --------- | -------- |
| Full reconcile with a policy summary | observed  | observed  | observed |
| SDK result without a runtime summary | retained  | retained  | retained |
| Apply retry                          | observed  | retained  | retained |
| Legacy delete retry                  | retained  | retained  | observed |
| Terminal run                         | converged | retained  | retained |
| Successful complete SDK cleanup      | converged | converged | removed  |

Missing runtime information does not prove cleanup happened. The complete
cleanup writer is permitted only after cleanup succeeds. A pending delete or
failed cleanup retains the published facts. An omitted condition group retains
it; an empty group removes it.

Historical combined `RetryPending` is decoded only when its message exactly
matches the old writer's frozen output. Other reasons retain their current
meaning. Historical `PrunePending` did not distinguish ordinary prune failure
from legacy-delete failure; it needs an actual full reconcile observation before
the current legacy retry fact can be established. It is not guessed into a
`DeletePending` condition.

## Resource deletion and scheduling

Live reconcile, SDK cleanup and retry use the same recipe-UID-keyed legacy
policy state. Success or 404 records removal and clears backoff. Other outcomes
retain pending state with a 60-second initial window, doubling to one hour.
The labelled cleanup sweep excludes the exact legacy name and sends it through
this same owner. A pending cleanup carries the remaining window to its caller.

Finalizer intent is explicit. It permits the last removal attempt inside a
live backoff window because deleting the recipe also removes its future retry
opportunity. Process-local state is forgotten after cleanup completes.

When only legacy removal remains, its timer queues that operation without
running the full workflow pipeline. It checks the current object after the queue
wait, checks identity again after the asynchronous DELETE, and publishes only
the owned condition group with UID and resourceVersion. Conflicts retry this
same operation. Replacement, deletion, stop or timer replacement cancels stale
queued work.

A successful conditions patch also produces an ordinary Kubernetes watch
event. Terminal runs keep their existing best-effort compute cleanup on that
event. The bridge test therefore asserts no additional teardown during failed
backoff windows, one ordinary terminal cleanup after recovery, and no new
legacy timer, legacy DELETE or publication loop.

## Required behavioral witnesses

| Boundary                           | Witness                                                               |
| ---------------------------------- | --------------------------------------------------------------------- |
| SDK without runtime or cleanup     | pending facts survive; cleanup has zero calls                         |
| Complete SDK cleanup               | cleanup succeeds before facts are cleared                             |
| Labelled legacy policy             | one central DELETE; no sweep bypass or repeated 404                   |
| Live cleanup within backoff        | no extra DELETE; exact remaining delay retained                       |
| Finalizer                          | last chance inside the window; 2xx and 404 map to observed gone       |
| Timer through real watcher and WRC | pod, transport and GFS effects remain unchanged during failed windows |
| Recovery watch event               | one ordinary terminal cleanup, then no retry or status loop           |
| Queued and in-flight replacement   | stale UID causes no new-object status patch or queued resource action |
| Version conflict                   | newest apply/prune facts survive; successful DELETE is not repeated   |
| Structured failure logging         | exact error object reaches the existing logger                        |

The controller fixtures mock Kubernetes at its API boundary while retaining
the real watcher, recipe queue and WRC consumer. The property-model ledger test
remains useful, but does not replace finalizer-to-ledger tests.

Relevant suites:

- `workflow-recipes/src/reconciler/reconciler.test.ts`
- `workflow-recipes/src/k8sClient.test.ts`
- `workflow-recipes/tests/unit/workflow/workflowReconciler.test.ts`
- `workflow-recipes/src/reconciler/oauthBrokerDeleteLedger.property.test.ts`

## Auxiliary recovery contracts

Profile stop/delete distinguish an unreadable identity from a readable
contradiction. They retain local endpoint, known-profile, ownership and
confirmation checks. The hermetic lifecycle suite uses runtime stubs, verifies
actual operation/record effects and asserts that its source checkout is unchanged.
It does not establish evidence on a real Minikube profile.

PostgreSQL teardown waits for held clients by identity with a bounded deadline.
Already-removed clients can still forward an administrative termination error
through their pool, so the shared teardown boundary must retain its error
observer after it returns. Unexpected errors remain failures. The AST guard
tracks actual local pool bindings and preserves HTTP/stream `end` calls; its
documented dynamic and cross-file limits are not a proof of every possible
JavaScript call form.

Relevant suites:

- `scripts/tests/test-branch-profile-lifecycle.sh`
- `control-api/test/helpers.realPostgresTeardown.test.ts`
- `control-api/test/realPostgresTeardown.guard.test.ts`

Source inspection, local tests, isolated real PostgreSQL, CI, Minikube T0/T1/T2,
development and production are separate evidence lanes. Passing one does not
certify the others or authorize deployment.
