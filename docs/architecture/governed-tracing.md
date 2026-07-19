# Governed Tracing Architecture

Governed tracing is an internal control-plane evidence system. It records what an agent,
administrator, or infrastructure controller did without turning tracing into authority or
control-plane backpressure. External trace transport, public retrieval, and third-party access are
not part of this subsystem.

## Authority and event families

Control API is the canonical writer and reader. Producers submit bounded evidence under verified
service credentials; server-side binding resolvers derive identity, resource, origin, scope, and
decision fields before persistence.

The physical event families remain separate:

| Family | Grain | Examples |
|---|---|---|
| `agent_run` | One normalized source occurrence in an agent or workflow run | lifecycle, tool call, LLM call, approval, token usage |
| `administrative` | One control-plane intent, action, or linked outcome | membership, host, recipe, or policy mutation |
| `infrastructure_telemetry` | One operational transition or bounded workload interval | reconcile, health, lifecycle, capacity, usage |

`AgentRunEventEnvelopeV1` is the canonical persisted Agent Event Envelope. Producer input and
server bindings are deliberately separate types so caller-controlled fields cannot masquerade as
control-plane authority.

Every accepted family row is registered in `governed_event_stream` in the same database
transaction. `GovernedEventReadService` is the application read boundary; HTTP handlers do not
read raw family tables directly.

## Ordering and gap semantics

`governed_event_stream.stream_sequence` is a monotonic database commit-order cursor. Numeric holes
are valid because PostgreSQL sequences are not transactional. The stream integrity metric detects
a persisted family row without its required stream pointer; it does not interpret a numeric hole as
lost evidence.

V1 does not claim a universal per-run source ordinal. Different producers do not expose one common
canonical sequence, and events may arrive after retries. Idempotency keys detect duplicate or
conflicting source occurrences, while root and parent bindings preserve the reconstructable run
tree. An event that a producer never emitted cannot be inferred from adjacent stream rows. Adding a
semantic missing-event detector requires a separately versioned producer ordinal contract rather
than guessing from database commit order.

## Decision evidence

Decision provenance is explicit:

- `approval_request` and `approval_resolution` mean Control API projected the corresponding
  independently persisted workflow approval occurrence.
- `legacy_gate` means an authenticated first-party mcp-host reported an outcome only after its
  bound user/channel gate accepted the decision. Control API validates the runtime credential,
  Host binding, run root, source occurrence, and source/payload status agreement, while preserving
  that this evidence is not a workflow-ledger resolution.
- `policy_evaluator` is the canonical policy-decision source kind. Historical `policy` and
  `runtime_guard` values remain readable for compatibility but are not emitted by current code.

Consumers must use `decision_source_kind` and `decision_source_ref`; they must not assume every
origin has the same corroboration level.

## Infrastructure cost data flow

The HTTP request path never calls Google Cloud:

1. `trace-maintenance-worker` samples the allowlisted Kubernetes deployment inventory off-path.
2. Control API stores capacity intervals as infrastructure telemetry.
3. Approved immutable price snapshots produce requested-capacity estimates.
4. The disabled-by-default GCP adapter can read a normalized, partition-bounded Cloud Billing
   export using Workload Identity and persist billed daily versions after an authorized rollout.
5. Control UI obtains available workload scopes from persisted `infrastructure_cost_daily` rows and
   queries reproducible day, week, or month projections.

Project, cluster, environment, namespace, workload, and currency are persistence dimensions. They
are selected from the server catalog, not typed by an operator. Period, anchor date, and valuation
remain operator choices. Missing price evidence or Billing Export evidence is unavailable, never
zero and never silently replaced by another valuation basis.

Live Billing Export, GKE cost allocation, normalized BigQuery views, IAM, Workload Identity,
NetworkPolicy egress, and feature activation are T3 operations. The production adapter remains
inert until those controls are configured; the fixture adapter is deterministic test
infrastructure and never activates GCP.

The base Deployment sets both cost flags to `false`. An authorized T3 overlay must enable and
configure the worker, never the Control UI or HTTP process:

| Variable                                       | Purpose                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `TRACING_INFRASTRUCTURE_COST_ENABLED`          | Enables Postgres-backed cost rollup in the maintenance worker                           |
| `TRACING_INFRASTRUCTURE_COST_ROLLUP_INTERVAL_MS` | Requested-capacity rollup cadence; defaults to one hour                               |
| `TRACING_INFRASTRUCTURE_COST_LOOKBACK_DAYS` | Closed UTC inventory days revisited for gaps and late evidence; defaults to 7             |
| `TRACING_INFRASTRUCTURE_COST_FINALIZATION_DELAY_HOURS` | Delay after UTC day close before requested-capacity evidence becomes final; defaults to 24 hours |
| `TRACING_GCP_BILLING_ENABLED`                  | Enables the off-transaction BigQuery import lane                                        |
| `TRACING_GCP_BILLING_QUERY_PROJECT_ID`         | Project in which the bounded BigQuery job runs                                          |
| `TRACING_GCP_BILLING_NORMALIZED_VIEW`          | Statically configured `project.dataset.view` allowlist target                           |
| `TRACING_GCP_BILLING_LOCATION`                 | Exact BigQuery job location                                                             |
| `TRACING_GCP_BILLING_MAX_BYTES_BILLED`         | Per-query byte ceiling; defaults to 1 GB                                                |
| `TRACING_GCP_BILLING_IMPORT_INTERVAL_MS`       | Import cadence; defaults to one hour                                                    |
| `TRACING_GCP_BILLING_MAX_LAG_HOURS`            | Maximum accepted export age; defaults to 96 hours                                       |
| `TRACING_GCP_BILLING_LOOKBACK_DAYS`            | Closed UTC days revisited for late billing data; defaults to 7, maximum 31              |
| `TRACING_GCP_BILLING_FINALIZATION_DELAY_HOURS` | Export-watermark delay required before a billed day becomes final; defaults to 96 hours |
| `TRACING_GCP_PRICING_ENABLED`                  | Enables normalized account-pricing import for immutable snapshots                       |
| `TRACING_GCP_PRICING_QUERY_PROJECT_ID`         | Project in which the bounded pricing-view query runs                                    |
| `TRACING_GCP_PRICING_NORMALIZED_VIEW`          | Approved `project.dataset.view` with CPU and memory effective account rates             |
| `TRACING_GCP_PRICING_LOCATION`                 | Exact BigQuery location of the pricing view                                             |
| `TRACING_GCP_PRICING_MAX_BYTES_BILLED`         | Per-query pricing-view ceiling; defaults to 100 MB                                      |
| `TRACING_GCP_PRICING_IMPORT_INTERVAL_MS`       | Pricing refresh cadence; defaults to 24 hours                                           |
| `TRACING_GCP_PRICING_MAX_LAG_HOURS`            | Maximum accepted pricing evidence age; defaults to 72 hours                             |

ADC obtains the workload identity at runtime. No service-account key or billing credential belongs
in a Secret, ConfigMap, browser request, or persisted trace payload. When either GCP import is
enabled, the worker rejects file- or JSON-based Google credential environment variables. The T3
overlay must bind the Kubernetes service account to a dedicated Google service account and grant
only BigQuery query-job creation plus authorized-view read access.

Google exposes two different pricing trust boundaries. Public Catalog/Pricing endpoints require no
billing-account IAM permission and can return list prices that are at most about 12 hours old, but
Google requires an API key and those prices do not include account contract terms. Account-specific
`billingAccounts.skus.price` calls require `billing.billingAccountPrice.get`; the predefined roles
Google documents for that permission are Billing Account Viewer and Billing Account Administrator.
The worker never receives either role and never calls an account-specific Pricing API.

For the most accurate preventive estimate, the approved pricing view should prefer the latest daily
Pricing Export rate for the applicable account, region, consumption model, tier, and currency. That
export includes account contract prices when present. Recent Detailed Usage Cost
`price.effective_price` is the observed-rate cross-check and fallback for SKUs already used. The
public Pricing API remains an optional list-price reference for a separately reviewed integration;
it is not a substitute for account pricing and this worker does not require an API key. The
normalized view must identify the selected basis and pricing timestamp in `source_ref`; unsupported
or ambiguous tiers remain unavailable instead of silently choosing a price. Enabling either export
is a FinOps-owned T3 action. Runtime access remains limited to BigQuery job creation and read access
to the authorized view; it receives no billing-account role.

Near-real-time estimates combine immutable account-rate snapshots with observed provisioned
intervals. A future Prometheus/metrics adapter may add the distinct `measured_usage` basis. Billing
Export remains the reconciliation source for provider allocation, credits, discounts, and
adjustments.

## Isolation and operations

HCC, WRC, and mcp-host perform only bounded synchronous enqueue on their critical paths. Network,
database, normalization, cost rollup, reconciliation, and retention work execute off-path with
separate concurrency and connection budgets.

Retention deletes at most 1,000 rows per wake across the three event families and infrastructure
costs. The maintenance worker is deliberately non-HTTP, so it does not register process-local
Prometheus series that cannot be scraped. Each completed wake emits structured operational fields
for duration, saturated retention grains, family-to-stream registration gaps, inventory volume,
and GCP import outcomes; overlap, lock, failure, and shutdown outcomes are emitted separately.
Producer-specific flush, drop, retry, and gap counters remain on the existing scrapeable HTTP
surfaces. Sustained non-empty `saturatedGrains` in the worker logs indicates that retention
throughput is not keeping pace.

Schema mutation runs only through the migration Job. Runtime roles are provisioned separately and
receive explicit relation, sequence, and function grants. Long-running HTTP and maintenance
processes perform readiness checks but do not own schema migration.

## Deferred surfaces

This architecture intentionally does not implement:

- OTLP export or collector configuration;
- public, pull, or third-party trace retrieval;
- exporter credentials or endpoint management;
- external retention guarantees;
- framework-specific adapters;
- deterministic re-execution.

Future read or push specifications must consume the existing policy-filtered internal read service
and define their own authentication, authorization, redaction, retention, and delivery contracts.
