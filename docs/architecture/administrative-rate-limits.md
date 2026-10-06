# Administrative rate limits and coordinated access

Control API owns request quotas. Control UI reduces redundant optional reads
and explains genuine throttling. A person’s action can generate several HTTP
requests, and each request can traverse several independent counters.

For one workload sharing the relevant principal and window, the action bound
is the minimum of each applicable budget divided by the operations that
action charges to it. A requests-per-minute setting is not a throughput
guarantee. Retries, failover and other methods consume additional allowance.

## Administrative browser path

Browser -> public ingress -> Control UI Next proxy -> Control API admin
authentication -> local edge guard -> shared PostgreSQL counter -> response.

The checked-in UI proxy has no requests-per-minute quota and forwards status,
body, Retry-After and quota headers. Checked-in Control UI calls Control API
directly; the repository’s nginx gateway configs contain no limit_req or
limit_conn on this path. Live Cloudflare/WAF policy, forwarding-IP trust and
actual deployed ENV owners remain deployment checks.

Subscription administration and capability discovery use the cookie accepted
by the parent administrator middleware. Quota attribution follows that same
cookie even when an unrelated Authorization header is present. Workflow
administration preserves its separate existing Bearer/cookie transport.

Read quotas are shared across subscription providers and capability discovery.
Writes have a separate quota. Neither family creates a global aggregate of
every administrator. Existing signed-session hashing and verified Host/recipe
bindings are preserved; a naming change does not choose a new identity policy.

## Configuration defaults

All values below count operations per minute unless stated otherwise. Valid
explicit numeric ENV and grant overrides remain authoritative; deliberately
lower overrides lower the effective workload capacity.

| Family | Configuration/default | Binding and inner coordination |
| --- | --- | --- |
| Subscription reads | CONTROL_API_ADMIN_SUBSCRIPTION_READ_PER_MIN=150 | Same signed browser credential across providers/capabilities; aligned edge and ledger. |
| Subscription writes | CONTROL_API_ADMIN_SUBSCRIPTION_WRITE_PER_MIN=100 | Separate from reads; no automatic replay. |
| Subscription callback | CONTROL_API_SUBSCRIPTION_OAUTH_CALLBACK_PER_MIN=100 | Per supplied state; no-state IP safeguard20. Presence is not state validation. |
| Workflow administrative reads | CONTROL_API_ADMIN_WORKFLOW_READ_PER_MIN=300 | Existing verified administrator credential. |
| Workflow grant reads/writes | CONTROL_API_ADMIN_WORKFLOW_GRANT_READ_PER_MIN=300; CONTROL_API_ADMIN_WORKFLOW_GRANT_WRITE_PER_MIN=100 | Separate families and aligned verified edge/ledger. |
| Administrative workflow trigger | CONTROL_API_ADMIN_WORKFLOW_TRIGGER_PER_MIN=50 | Existing verified caller. External/MCP trigger contract remains10. |
| Outputs reads | CONTROL_API_ADMIN_OUTPUTS_READ_PER_MIN=150 | Existing administrator binding. |
| Host wake | CONTROL_API_HOST_WAKE_RL_PER_MIN=150 | Verified Host reference after authentication and Host match. |
| Registry keys/grants/status/connect/recovery | CONTROL_API_ADMIN_REGISTRY_KEYS_PER_MIN=150; GRANTS=150; CONNECT_STATUS=150; CONNECT_REQUEST=15; CONNECT_RECOVERY=50 | Separate authenticated administrator-subject families; each suffix uses the CONTROL_API_ADMIN_REGISTRY_ prefix. |
| Connector deletion | CONTROL_API_ADMIN_CONNECTOR_DELETE_EDGE_PER_MIN=300; CONTROL_API_ADMIN_CONNECTOR_DELETE_PER_MIN=150 | PostgreSQL150 controls the authenticated allowance. Authorization is preserved. |
| SDK admin/internal | CONTROL_API_PLUGIN_SDK_ADMIN_PER_MIN=600; CONTROL_API_PLUGIN_SDK_INTERNAL_PER_MIN=600 | Verified principal; internal signed iss/sub separated from invalid/anonymous IP600. |
| SDK authenticated request/preauth | CONTROL_API_PLUGIN_SDK_REQUEST_BUCKET_PER_MIN=6000; CONTROL_API_PLUGIN_SDK_AUTHENTICATED_PREAUTH_PER_MIN=6000 | Verified runtime Host/recipe; aligned calendar minute. |
| SDK anonymous preauth | CONTROL_API_PLUGIN_SDK_PREAUTH_PER_MIN=600 | Source-IP first-hit backstop; a valid attributed runtime JWT does not consume it. |
| SDK credential operations | CONTROL_API_PLUGIN_SDK_CREDENTIAL_PER_MIN=1800 | Reissue and both introspections share this quota. Ticket authority/binding and single use remain. |
| SDK prompt/notification defaults | CONTROL_API_PLUGIN_SDK_PROMPTBRIDGE_PER_MIN=600; CONTROL_API_PLUGIN_SDK_NOTIFICATIONS_PER_MIN=750 | Explicit grant overrides remain; existing method-quota window semantics remain. |
| Approval request/refresh/reissue | APPROVAL_RL_REQUEST_PER_MIN=600; APPROVAL_RL_REFRESH_PER_MIN=100; APPROVAL_RL_REISSUE_PER_MIN=25 | Existing verified binding and token rotation semantics. |
| Provider attempt authorization/OAuth broker | CONTROL_API_LLM_PROVIDER_ATTEMPT_AUTHORIZE_PER_MIN=300; CONTROL_API_OAUTH_BROKER_RL_PER_MIN=300 | Existing verified domain budgets; unverified attempt-authorization IP60 remains. |
| Administrative GFS grants/shares/report | CONTROL_API_ADMIN_GFS_GRANTS_PER_MIN=150; CONTROL_API_ADMIN_GFS_SHARES_PER_MIN=150; CONTROL_API_ADMIN_GFS_LEGACY_GRANT_REPORT_PER_MIN=150 | Existing operator permissions; grants/read-write and shares keep their own families. |

Code defaults and base/minikube ConfigMap literals must agree. A code-only
increase can be defeated by an older deployment override. This document and
changed manifests are source artifacts, not confirmation of a rollout.

## SDK verification budget

The SDK pre-auth gates and the internal SDK edge verify a bearer token to
choose a bucket, so the IP600 ceiling cannot deny before that verification.
A per-source-IP verification budget runs first on both SDK routers. It counts
only requests that present a bearer token, uses
CONTROL_API_PLUGIN_SDK_AUTHENTICATED_PREAUTH_PER_MIN (6000) as its limit, and
denies further tokens from that IP without verifying them. Invalid credentials
still stop at IP600, and valid callers behind a flooded IP keep passing until
the IP has spent 6000 verifications in the minute. Verified principals that
share one source IP share this budget, and the internal SDK edge allowance
cannot exceed it from one IP.

## SDK operation multiplicity

A healthy static-secret attempt performs reissue, pre-Secret introspection and
post-Secret introspection/redemption. At the old 120 operation allowance this
guard admitted at most40 healthy attempts per minute. All three operations
are retained. 1800 operations make600 healthy single-attempt prompts possible
through this guard.

Each sequential prompt also requests fresh capability proof, authorizes and
closes its lifecycle. SDK-only closure totals six Control API requests; a
runtime with separate provider/invocation status closure totals seven. 600
healthy prompts therefore consume 3600/4200 general requests before bootstrap,
other methods or retries. Both authenticated request gates default to 6000.
Capability authority is not cached to reduce those charges.

The calculation above models the healthy static-secret SDK path only. That path
does not call the separate direct-Host provider-attempt authorization or OAuth
broker routes. Subscription/OAuth SDK paths can call those routes and therefore
also face their budgets of 300 operations per minute. Each path must use its own applicable
counters; provider/account quotas and retries can lower capacity further.

The three credential requests carry the Host runtime access JWT, including
the requests forwarded by WRC. They are attributed to that verified Host or
recipe, not to WRC’s internal service identity. Namespace equal to the Hosts
namespace uses primary hostRefs[0]; other callers use namespace/recipeName.
Both paths retain signature, audience, expiry and normalized binding checks.

## Windows, headers and backend outages

Authenticated edge counters and the PostgreSQL ledger use calendar minutes.
A late first request no longer leaves an exhausted edge counter active after
the database reset. Server-generated source-IP keys retain the previous
first-hit abuse window. Always-counted calendar stores do not enable
skipSuccessfulRequests or skipFailedRequests.

The last enforcing ledger or process-memory counter owns draft7, draft6 and
legacy X quota metadata. 429 includes rate_limited, a readable message,
retryAfterSeconds and Retry-After. 503 unavailable removes stale quota metadata
and retains its retry contract; an unavailable count is not zero usage.

The existing PostgreSQL outage policy is unchanged. Process-memory counters
are per process and use first-hit 60 s windows with bounded key cardinality.
Their counters do not combine with PostgreSQL, and they are not a distributed
quota. Outage recovery can therefore differ from normal ledger enforcement.

## Naming and active accounting

Shared infrastructure uses capability names. The previous admin_codex_read,
admin_codex_write and codex_oauth_callback categories become subscription
categories; legitimate vendor protocol identifiers remain specific.

The namespace migration merges counts atomically inside the existing migration
transaction and preserves windows/suffixes. An invoker trigger normalizes old
writers during rolling updates and supported rollback. Existing bounded long
key digests and the 512-byte boundary remain compatible. Do not clear counters
to pass a smoke test. Retire the compatibility trigger only through a later
reviewed migration after old writers and rollback support are retired.

## Control UI recovery

Only allowlisted safe subscription metadata uses browser-local reuse: TTL 30 s,
maximum 128 entries, origin/principal/scope/session-epoch binding and a shared
subscription-read cooldown. Ordinary Agent sections do not fetch optional
subscription inventory; editor opening loads it when needed.

At most one shared idempotent recovery GET proceeds after a denial deadline.
Forced refresh respects the same pause. Authentication changes, 401 and
cross-tab invalidation fence old awaits and clear identity-bound state.
Aborting one subscriber does not cancel another subscriber’s shared request.
SSR does not retain cached/deduplicated results across requests.

Do not cache authentication decisions, general mutable reads, file contents,
OAuth polling or credentials. Mutations and OAuth operations are not replayed
automatically. Optional provider failures preserve independent Agent data,
known summaries and drafts; unknown availability is not disabled availability.

## Evidence and rollout boundary

Unit/build, real PostgreSQL, local T0/T1/T2, visible browser and deployed
receipts are distinct. Require actual selected tests, complete reports and
producer exit 0; skipped physical tests do not establish correctness.

For an authorized rollout, verify effective numeric owners, source/image
revision, ledger migration ordering, old-writer drain, independent identities,
forwarding policy and visible recovery. Keep upstream provider quotas, bytes,
concurrency and unrelated authentication/minting safeguards separate. A 429 must
remain possible under deliberate overload and must be understandable.

References: issue #985; #433 owns broader edge-store/cardinality coordination;
#438 owns changes to principal policy. Neither is silently replaced here.
