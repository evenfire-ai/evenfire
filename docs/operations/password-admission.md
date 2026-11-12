# Password admission availability and monitoring

## Approved admission policy

Password login retains the BUG-192 capacity controls and the five-failure guessing boundary:

- Five attempts per trusted source per minute.
- Up to 40 committed public password-authentication completions per normalized identifier in a
  rolling 15-minute window.
- A shared risk budget of five confirmed failures plus conservative uncertain-work debits per
  normalized identifier. Only the fifth confirmed failed verification starts the ordinary
  completion-anchored 15-minute cooldown.
- Success and authenticated password reverification preserve prior failures and any active
  cooldown. Trusted credential/lifecycle transitions remain the only approved reset boundary.
- One cost-12 password verification permit every 7.5 seconds, concurrency one,
  with no queue and no pace refund.

Each eligible request reserves one durable provisional operation before credential lookup or
bcrypt. A 41st public request inside the success window follows the same identifier lookup and
generation-fencing path, then uses the precomputed cost-12 dummy hash without comparing the real
credential. It returns the same generic 401 as an unknown identifier and charges one shared
failure-risk unit. Confirmed failures and uncertain outcomes consume the same five-unit risk
budget. Risk exhaustion caused by uncertainty alone does not create the ordinary cooldown; absent
an active cooldown, admission becomes eligible again when an old risk entry expires.

For example, four confirmed failures at minutes 0, 5, 10 and 12 plus one uncertain outcome at
minute 14 exhaust the shared risk budget without starting a cooldown. Admission can become eligible
again when the minute-0 failure reaches the 15-minute rolling-window boundary. A fifth confirmed
failure at minute 14 instead starts a cooldown through minute 29, anchored to that verification's
completion time.
The cap is an admission target, not a guarantee of 40 delivered HTTP responses:
source limits, failure cooldown, global pace, the shared work owner, session creation and downstream
availability still apply. Response loss after a committed success does not refund the success.

The shared failure-risk state protects account-wide guessing and paces public
cost-12 password verification. The durable work owner serializes all member-account
bcrypt work: password verification, recovery hashing, accepted-invitation password
setup, and authenticated password changes. Recovery and password-setting work bypass
the anonymous 1-per-7.5-second start pace, so that rate limit does not cover aggregate
bcrypt starts across these member-account flows. Control Admin credentials use a
separate authentication subsystem outside this policy. Distributed sources can
consume the public pace while staying below their individual source limits. Ordinary
anonymous logins can consequently receive HTTP 429 during sustained pressure. This
availability tradeoff is retained; the global starvation mechanism has not been
removed, and monitoring alone does not mitigate it.

## Verified recovery

A password-reset invitation issued by the trusted member-registration flow can set a
new password without reserving the anonymous login pace. The reset credential is
validated for signature, registered identity, email, invitation purpose, expiry and
pending state. The password update and sibling reset-link revocation commit together.
Control API returns no session from that mutation. External REST clears any
invitation or recovery session cookie it receives and answers with
`reauthenticationRequired: true`, so Profile UI shows a password-updated screen
and a link to sign in. The person then authenticates through the ordinary login
route; only that login issues a session.

Recovery hashes use the existing durable `password_verification_work` singleton.
Authenticated password changes and accepted-invitation password setup use that same
owner. This keeps member-account bcrypt concurrency at one across service processes
and fails closed when the owner is busy or database authority is unavailable. There
is no recovery queue or second concurrent member-account bcrypt lane. A request may
receive 429 while the owner is held; retry after its sanitized `Retry-After` interval.

Password reset keeps the public success quota and legacy admission hold. The
credential-generation fence clears failures, uncertainty and cooldown state for the
new credential. A reset link cannot be exchanged through the generic invitation-accept
endpoint, reused after redemption, or used to create a session before the password
transaction commits.

Reset-link issuance retains the existing five-per-minute per-email limiter in
Control API and the five-per-minute External REST limiter. Completing a link is
also source-limited at ten requests per minute and uses the one-time pending-link
state plus the global durable bcrypt owner; the endpoint does not reserve the
anonymous login pace.

## Cross-service rollout

The Control API reset-completion behavior and External REST consumer form one
contract. Roll them out as a coordinated change, with the Control API route
available before the updated External REST route serves reset completions, then
deploy the Profile UI navigation update. During a mixed-version window, reset
completion may fail closed: the old consumer cannot complete through the new
Control API, and the new consumer cannot find the endpoint on an old Control API.
Retry recovery after the coordinated rollout is healthy. Roll back External REST
and Profile UI together before rolling Control API back; do not leave the new
consumer pointed at a Control API without the password-token endpoint.

## Password-admission adoption and rollback

The public `build-publish.yml` workflow is triggered by pushes to `dev`; feature-branch pushes
and opening a draft PR do not match that deployment trigger. A `dev` merge builds changed images
and dispatches the private development integration path only when its repository dispatch
configuration is enabled and images were built. The integration path runs the Control API
migration job before applying the rendered release, and the current Control API Deployment uses
`Recreate`. The migration runner is forward-only. Its first durable transaction changes the
rollout phase, installs database guards, and only then records the fence timestamp. Trigger
installation waits for legacy transactions already writing admission state, so the timestamp
follows any such completion that can still commit. After that transaction commits, old binaries
cannot mutate identifier admission state or acquire a new work-owner slot. The migration waits
for the shared durable work-owner row to empty before applying schema 0130; a legacy completion
attempted after owner release is fenced and cannot produce an authenticated response. The
conservative legacy hold lasts at least 15 minutes after the committed fence timestamp,
preserving the full possible old-success horizon without treating old attempt timestamps as
outcomes. If migration ordering, the guard-lock barrier, or the `Recreate` strategy changes, stop
adoption until the pipeline again proves schema-first application and non-overlapping verifier
execution.

The conservative legacy hold preserves the remaining Spec 043 attempt horizon without guessing
which old admitted requests were successes. An old verifier must not be restarted against schema
0130: its admission writes fail closed. A rollback that needs an old verifier requires a reviewed
quiescent conversion, exact-incarnation termination proof, and preservation of active success,
failure, uncertainty and work-owner state. There is no automatic down migration. Leave password
authentication unavailable rather than deleting active state or opening a second bcrypt lane.

The public image workflow does not build or dispatch from `main`; production promotion is handled
by the separate private release path. This change does not initiate that path or any deployment.
Production capacity remains unmeasured, and the unchanged global pace, concurrency, bcrypt cost
and source limits remain in force.

## Signals and operator response

Control API exports `password_admission_denials_total{reason}` on its internal
`/metrics` endpoint. Its finite, low-cardinality reasons are `source_rate`,
`identifier_attempts`, `identifier_cooldown`, `identifier_migration_hold`,
`identifier_operation_busy`, `global_pace`, `verification_busy`, and `authority_failure`.
No identifier, source address, credential or account existence is used as a metric label. The
source limiter also exports its existing
`rate_limit_hits_total{bucket_type="external_authentication_attempt",result="unavailable"}`
series when its PostgreSQL backend cannot enforce the source limit.

Use this query for a dashboard grouped by rejection class:

```promql
sum by (reason) (increase(password_admission_denials_total[5m]))
```

Suggested alert policy for a Prometheus-compatible monitor:

- Notify operators when `global_pace` denials occur in a five-minute window. Treat
  this as a saturation/availability signal and correlate it with request volume,
  CPU throttling and login success rates; it is not proof of an attack by itself.
- Alert immediately on any `authority_failure` in a five-minute window. Check
  PostgreSQL reachability and Control API logs without logging request identities.
- Alert on any `external_authentication_attempt` limiter `unavailable` result;
  source pacing is fail-closed, so this means login requests are being rejected
  because the limiter cannot establish authoritative counts.
- Review `identifier_attempts`, `identifier_cooldown`, `identifier_operation_busy`,
  `identifier_migration_hold`, `source_rate` and `verification_busy` together to distinguish
  targeted guessing, source abuse, rollout holds and work-owner contention.

The repository currently provides the Control API metrics endpoint and Grafana/Loki
starter configuration, but does not configure a Prometheus scraper or alert manager.
Install the query and alert policy in the deployment's authorized monitoring system;
do not treat an uninstalled rule as deployed coverage.

Production throughput and production-representative capacity are unmeasured. Keep
`paceMs=7500`, concurrency one, bcrypt cost 12 and the current source limits unchanged.
The 40-success accounting tests establish functional behavior only; they do not establish a
40-login availability SLO or a production capacity result. Before a separate capacity-policy
change, measure production per-replica CPU requests and limits, effective container CPU quota and
throttling, Node.js runtime allocation, cost-12 bcrypt latency/throughput at concurrency one, and
normal login arrival rates.
The checked-in base Control API manifest requests 50m CPU and 128 MiB memory, with
limits of 300m CPU and 768 MiB memory. Those values do not establish effective
production sizing: the active overlay, replica/HPA count, container cgroup quota,
throttling, runtime architecture/version, production bcrypt latency, and normal
arrival rate/SLO still need measurement. Local functional tests are not production sizing evidence.
No higher pace or additional concurrency is authorized by this policy.
