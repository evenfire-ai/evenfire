# Password admission availability and monitoring

## Approved admission policy

Anonymous password login retains the Spec 043 controls:

- Five attempts per trusted source per minute.
- Five admitted attempts per normalized identifier per 15-minute window.
- A 15-minute failure cooldown after five password failures.
- One cost-12 password verification permit every 7.5 seconds, concurrency one,
  with no queue and no pace refund.

These anonymous-login limits protect account-wide guessing and pace public
cost-12 password verification. The durable work owner also keeps verification and
recovery hashing at global concurrency one. Recovery hashes bypass the anonymous
1-per-7.5-second start pace, so that rate limit does not cover aggregate bcrypt
starts across both lanes. Distributed sources can consume the public pace while
staying below their individual source limits. Ordinary anonymous logins can
consequently receive HTTP 429 during sustained pressure. This availability tradeoff
is retained; the global starvation mechanism has not been removed, and monitoring
alone does not mitigate it.

## Verified recovery

A password-reset invitation issued by the trusted member-registration flow can set a
new password without reserving the anonymous login pace. The reset credential is
validated for signature, registered identity, email, invitation purpose, expiry and
pending state. The password update and sibling reset-link revocation commit together.
Only after that commit does Control API issue the normal signed session, which
External REST stores in the profile session cookie.

Recovery hashes use the existing durable `password_verification_work` singleton.
This keeps bcrypt concurrency at one across service processes and fails closed when
that owner is busy or database authority is unavailable. There is no recovery queue
and no second bcrypt lane. A concurrent request may receive 429 while the owner is
held; retry the verified recovery request after its sanitized `Retry-After` interval.

Password reset keeps the public identifier attempt timestamps. The existing
credential-generation fence clears failure cooldown state, while any remaining
attempt-budget exhaustion continues to deny anonymous login until its normal window
expires. A reset link cannot be exchanged through the generic invitation-accept
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

## Signals and operator response

Control API exports `password_admission_denials_total{reason}` on its internal
`/metrics` endpoint. Its finite, low-cardinality reasons are `source_rate`,
`identifier_attempts`, `identifier_cooldown`, `global_pace`, `verification_busy`,
and `authority_failure`. No identifier, source address, credential or account
existence is used as a metric label. The source limiter also exports its existing
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
- Review `identifier_attempts`, `identifier_cooldown`, `source_rate` and
  `verification_busy` together to distinguish targeted guessing, source abuse and
  work-owner contention.

The repository currently provides the Control API metrics endpoint and Grafana/Loki
starter configuration, but does not configure a Prometheus scraper or alert manager.
Install the query and alert policy in the deployment's authorized monitoring system;
do not treat an uninstalled rule as deployed coverage.

Before changing global throughput, measure production per-replica CPU requests and
limits, effective container CPU quota and throttling, Node.js runtime allocation,
cost-12 bcrypt latency/throughput at concurrency one, and normal login arrival rates.
The checked-in base Control API manifest requests 50m CPU and 128 MiB memory, with
limits of 300m CPU and 768 MiB memory. Those values do not establish effective
production sizing: the active overlay, replica/HPA count, container cgroup quota,
throttling, runtime architecture/version, production bcrypt latency, and normal
arrival rate/SLO still need measurement. The current local measurements are not
production sizing evidence. No higher pace or additional concurrency is authorized
by this policy.
