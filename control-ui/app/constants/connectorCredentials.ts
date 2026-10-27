// This timeout MUST stay strictly greater than the HCC's own readiness budget
// (host-context-controller reconciler.ts: pollReadiness, 24 attempts × 5s =
// 120s), plus room for the SecretInformer round-trip and one poll interval.
//
// The two budgets are not interchangeable, and the slack between them is
// load-bearing in BOTH directions:
//
//  - When a rollout fails, the HCC writes the diagnosis — DeploymentReady=False
//    reason=RolloutIncomplete with the rollout numbers — at the END of its
//    budget. If this timeout expired first, the operator would see a bare
//    "timed out" instead of the diagnosis that was about to arrive.
//  - When a rollout is merely SLOW (a loaded cluster, a long image pull), the
//    HCC exhausts its 120s budget and writes RolloutIncomplete before the pod
//    goes Ready — and then its post-terminal re-poll (reconciler.ts,
//    performReconcile) arms one more window and CORRECTS the condition to
//    True/ReplicasAvailable once the Deployment converges. The ~60s this
//    timeout outlives the HCC budget is precisely the observation slack in
//    which that correction lands. Latching failure the moment RolloutIncomplete
//    appears would throw that slack away and report a deterministic false
//    negative for any rotation converging between 120s and 180s (issue #223).
//
// Exported so the tests drive fake timers off THESE values instead of keeping
// their own copy: a duplicated budget silently stops testing the real one the
// first time either side changes.
export const POLL_INTERVAL_MS = 3_000
export const POLL_TIMEOUT_MS = 180_000

// The `reason` the HCC stamps on DeploymentReady=False when ITS readiness poll
// has exhausted its budget. Terminal for that poll window — but NOT
// irreversible: the HCC's post-terminal re-poll keeps observing and rewrites
// the condition to True/ReplicasAvailable if the Deployment converges later.
// For this UI it therefore means "keep the diagnostic, keep polling until OUR
// budget expires", never "stop and declare failure". Every other False
// (notably `WaitingForReplicas`) is a transitory rollout state with no
// diagnostic value. Must match host-context-controller/src/reconciler.ts.
export const ROLLOUT_INCOMPLETE_REASON = 'RolloutIncomplete'

// Slack subtracted from the client-side cutoff to absorb clock skew between the
// browser and the Kubernetes API server (which stamps lastTransitionTime). Must
// stay well under a real rollout's duration so a stale condition is still
// excluded. 5s comfortably covers ordinary NTP drift.
export const CLOCK_SKEW_TOLERANCE_MS = 5_000

// Matches the existing MCP Secret endpoint naming contract.
export const MCP_SECRET_NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

// Match the names already forbidden by the existing plain-env API validator.
export const CREDENTIAL_FORBIDDEN_ENV = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'PATH',
  'NODE_OPTIONS',
  'PYTHONPATH',
  'JAVA_TOOL_OPTIONS',
  'KUBECONFIG',
  'KUBERNETES_SERVICE_HOST',
  'KUBERNETES_SERVICE_PORT',
])
