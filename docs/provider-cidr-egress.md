# Provider-CIDR egress (issue #299 Phase 2)

For a large, rotating IP pool behind a DNS host (GitHub, Google GFE, AWS S3/CloudFront,
Microsoft 365), a Phase-1 `/32` sliding window is only a *sample* of the pool — a fresh
connection to an un-observed IP is denied (`fetch failed`). Phase 2 renders the
**authoritative published provider CIDRs** for such hosts, keeping the `/32` window for
small/stable hosts and for residual (out-of-range) IPs.

## Architecture at a glance

![Provider-CIDR egress architecture: control-api cron fetches provider netblocks and writes the clerum-provider-netblocks ConfigMap; HCC and WRC read it and render NetworkPolicy egress with the provider CIDR ipBlock; Calico enforces it.](assets/issue-299-phase2-architecture.svg)

Flow: **fetch** (control-api cron → provider netblocks) → **write** the `clerum-provider-netblocks`
ConfigMap → **read** by HCC and WRC → **render** a NetworkPolicy (ipBlock = provider CIDR,
port-scoped) → **enforce** by Calico. Provider intent travels through the CRDs; concrete CIDRs
travel only through the catalog. Provider names live only in the registry/fetchers/seed/tests
(generality invariant, enforced by a CI grep-gate).

## How it works

- **control-api** (the only *control-plane* component that fetches from the internet; workloads reach it through exactly the policies this feature renders) fetches each provider's
  published netblocks on a background loop, validates them through the pure core, and
  materializes the cluster ConfigMap `clerum-provider-netblocks` (namespace `control-plane`).
- **HCC / WRC** read that ConfigMap on their existing resync — they never fetch. A binding
  declares intent (`egressClass: provider` + `provider: { name, categories }`), never raw
  CIDRs; the controller resolves `name → CIDRs` from the ConfigMap and renders port-scoped
  `ipBlock` rules.
- A vendored **seed** ConfigMap (`deploy/base/control-plane/provider-netblocks-configmap.yaml`,
  regenerate with `make vendor-provider-netblocks`) covers cold start; worst case degrades
  to Phase-1 `/32` behavior, never below.
  - **Operator-visible tradeoff:** the seed is in the `resources:` apply set, so every
    `kubectl apply -k` snaps the live catalog back to it, discarding CIDRs the fetcher wrote
    since the last deploy. This self-heals: the seed's `_meta.etag` is `null`, so the next tick
    cannot 304 and does a full fetch — ~1-2 min after an image-changing deploy, at most one
    refresh interval (6 h) after a config-only apply. Until then, bindings render the seed's
    ranges (not nothing, and not a failure). The full rationale is in
    `deploy/base/control-plane/kustomization.yaml`.

This milestone (M1) ships a fetcher and seed for **GitHub only**; bindings declaring the
other registry providers (aws, google, cloudfront, microsoft) fail closed with an explicit
reason until their fetchers land.

## Kill switch

`PROVIDER_NETBLOCKS_FETCHER_ENABLED=false` disables the control-api fetcher entirely (the
seed ConfigMap + the `/32` window keep egress working). Other knobs:
`PROVIDER_NETBLOCKS_REFRESH_INTERVAL_MS` (default 6h), `..._FETCH_TIMEOUT_MS` (10s),
`..._MAX_RESPONSE_BYTES` (8MB), `..._CONFIGMAP_NAMESPACE` (`control-plane`).

## Observability & the drift alert (P1)

Provider mode is **availability-first**: a resolved IP outside every declared range still
enters the `/32` window (never denied) **and** raises a loud drift signal. In this milestone
the signal is a **metric + a throttled log** in the controllers; wiring a pager is an
operator decision (the repo ships no alert-rule manifests).

| Signal | Where |
|---|---|
| `clerum_hcc_external_egress_provider_drift_total{server,dns}` | HCC, every reconcile with an uncovered fresh IP |
| `clerum_wrc_external_egress_provider_drift_total{recipe,fqdn}` | WRC ui + workload reconcilers (metric every reconcile; a `[WR-Reconciler] provider-range drift …` log is emitted throttled) |
| `clerum_provider_netblocks_fetch_failures_total{source,reason}` | control-api fetch pipeline |
| `clerum_provider_netblocks_last_success_timestamp_seconds{source}` | control-api (staleness derive) |
| `clerum_provider_netblocks_cidrs{source,category}` | control-api (materialized IPv4 counts) |
| `clerum_provider_netblocks_ticks_total{result}` | control-api (`ok\|all_failed\|skipped_lock\|error`). **`all_failed`** is emitted when every configured fetcher failed in one tick — it deliberately does NOT report `ok`, so a dashboard keying only on `result=ok` would show a gap rather than a false green. Alert on it. |

**Drift paging alert contract** (configure in your monitoring stack — Grafana Cloud or GCP
Monitoring — the repo has no `PrometheusRule` manifests):

```promql
# Sustained drift on any host must PAGE — a 100%-residue misclassification (a
# mis-mapped host) is only caught if someone is alerted. Availability is preserved
# regardless; the alert turns a "silent #299" into a loud, one-line remap.
(
  sum by (dns) (increase(clerum_hcc_external_egress_provider_drift_total[30m])) > 0
) or (
  sum by (fqdn) (increase(clerum_wrc_external_egress_provider_drift_total[30m])) > 0
)
# for: 30m (3 consecutive 10m evaluations). Both controllers are covered — the
# WRC surface is where #299 reproduced live, so its twin must page too.
```

**Staleness alert** (the fetcher stopped succeeding): derive
`time() - clerum_provider_netblocks_last_success_timestamp_seconds{source}` →
**warn > 7d, critical > 30d**.

## Cross-environment portability

NetworkPolicy egress is evaluated at the source pod against the *original* destination, so
SNAT (GKE Cloud-NAT, EKS NAT-GW, DOKS SNAT) never breaks provider-CIDR matching. Nothing
reads enforcement state, so the degradation floor is always Phase-1 behavior.

| Env / CNI | NP egress enforced? | Verdict |
|---|---|---|
| minikube · Calico | yes | expected — GATE 2/3 pending |
| GKE · Calico addon | yes | expected (CNI conformance) — unverified † |
| GKE · Dataplane-V2 (Cilium) | yes | expected — unverified † (Cilium `ipBlock` matches *world* dsts; pin `except` conformance) |
| EKS · **default VPC CNI** | **no — policies inert** | **no-op-safe**: detect + document, never certify as enforcing |
| EKS · Calico addon / VPC-CNI NP agent (strict) | yes | expected (CNI conformance) — unverified † |
| DOKS · Cilium | yes | expected — unverified † |

† "expected" rows are semantic expectations from CNI NetworkPolicy `ipBlock` conformance, **not**
live-verified in this repo. Only minikube · Calico has a planned live gate (GATE 2/3, pending — the
`e2e-provider-cidr-egress.sh` make target is not yet a CI job). Do not read "expected" as "proven".

**IPv6 stance:** provider ranges are stored family-keyed but rendered **IPv4-only**. On
dual-stack, v4-only rules are fail-closed for v6 (safe). IPv6-only clusters are unsupported.

## Provider bindings under a permanent DNS failure (the seam rule)

The catalog CIDRs do **not** depend on the controller's DNS — that is the whole point of
provider mode (#299 root cause). So a provider binding whose FQDN receives a *permanent,
non-blocked* answer (NXDOMAIN / no A records) **still renders its catalog CIDRs**, in both HCC
and WRC. DNS gates only the residual `/32` sliding window, never the catalog. This is the
authoritative seam rule — see
[docs/architecture/issue-299-phase2-dns-failure-seam.md](architecture/issue-299-phase2-dns-failure-seam.md)
for the full decision table and the guards.

The limitation is now **blocked-only**: a binding whose FQDN resolves *into a blocked/private
range* (a resolver sinkhole or active poisoning — the maximally-suspicious slice) fails closed
loud, and so does any binding co-declared with a non-provider **exact-host** sibling on the same
FQDN (that sibling has no catalog to fall back on, so the whole policy fails closed — this is
what keeps a same-FQDN exact-host binding from silently inheriting the exemption). H3/LKG is
unaffected — any *live* NP is retained on failure. The blocked-vs-absent distinction is carried
by a structured `failureKind` discriminator on the resolver (never string-matched), so an error-
message edit can never flip a blocked answer into a served one.

**Decay trade-off (accepted; the WRC signal is NOT mirrored in HCC — see below):** while a provider host's DNS stays absent, its
residual `/32` window expires after ttl+overlap and the grant decays to *catalog-only*, breaking
egress to any drifted (out-of-catalog) endpoints. Every such IP was flagged at entry by the drift
canary, and the catalog-only state is surfaced by the `clerum_wrc_external_egress_permanent_dns_exempted_total`
metric plus a throttled log (drift-canary parity — the recipe no longer flips to a terminal
`failed` phase, so the metric is the durable operator signal). Operator action: fix the
controller's DNS (or the binding's FQDN); the binding re-folds the window on the next reconcile.

> **Asymmetry, stated rather than glossed:** HCC has **no counterpart metric**. Its identical
> catalog-only decay emits one unthrottled `console.warn` per reconcile
> (`networkPolicyReconciler.ts`) and nothing alertable. An operator watching
> `clerum_wrc_external_egress_permanent_dns_exempted_total` is blind to the same condition on the
> McpServer surface. Closing that gap is tracked separately; do not read this section as
> "both controllers are covered".

## Rollout order (forward)

The `Rollback` section below says never to revert controllers while provider bindings exist.
The forward direction needs the same care and nothing enforces it:

1. **Controllers first.** Roll HCC and WRC to an image carrying provider mode **before** the CRD
   and control-api start admitting `egressClass: provider`.
2. **Why it matters, and how the two surfaces differ:** an *old* WRC rejects an unknown
   `egressClass` from a pure validator and aborts before any write — loud, no GC. An *old* HCC
   does not: it skips the binding **before** marking the policy as desired, so the stale-policy
   sweep **deletes the live NetworkPolicy**. Silent egress loss.
3. **The realistic trigger is not a human.** HCC runs `strategy: Recreate` with `replicas: 1`, so
   a normal rollout has no version overlap. But the deploy workflows own an automatic
   `rollout undo --to-revision` for that Deployment (see the contract in
   `deploy/base/control-plane/host-context-controller.yaml`). If that fires while the CRD and
   control-api are already new and provider bindings are live, it reproduces exactly the state
   this section forbids, with nothing consulted first. Gating that automation is tracked
   separately.

## Rollback

Reverse of apply: (1) flip provider bindings back to `/32` mode; (2) revert controllers;
(3) kill-switch/revert the control-api fetcher (seed + `/32` window keep working); (4) leave
the CRD `provider` property in place; (5) revert the core **last**. Never revert controllers
while provider-mode bindings still exist (old code has no `provider` branch → egress loss).

## Duplicate-binding guard: McpServer only (by design)

The duplicate-`(dns, port)` guard (H4) lives on the **McpServer/HCC** surface only. It exists
because HCC derives a **NetworkPolicy name per (dns, port)**, so two identical pairs would
collide on the same NP name.

It is enforced in **two** places, and deliberately **not** in a third:

| layer | file | behaviour |
| --- | --- | --- |
| control-api admission | `control-api/src/http/validateMcpServerSpec.ts` | rejects the write |
| HCC reconciler (H4) | `host-context-controller/src/networkPolicyReconciler.ts` | fails loud, retains the live NP |
| CRD CEL | `charts/clerum-crds/crds/mcpserver.yaml` | **absent by design — ships separately** |

The CEL rule is the only rule on that CRD that would reject an object a cluster accepts today,
so it is reviewed on that risk alone rather than bundled with egress (see the comment beside the
`egressBindings` validations). The consequence is explicit: a **direct `kubectl apply`** of a
colliding pair — bypassing control-api — **is admitted by the apiserver**, and then fails loud at
reconcile with the live NetworkPolicy retained. Writes that go through control-api are rejected
up front.

It is intentionally **absent** on the **WorkflowRecipe/WRC** surface. WRC renders **one
NetworkPolicy per workload**, with each binding contributing *rules* inside that single policy —
there is no per-binding NP name to collide, so the collision hazard the guard prevents does not
exist there. A duplicate `(dns, port)` declaration on a WRC workload renders redundant-but-identical
egress rules (harmless; the CNI de-duplicates). Adding an authoring-time WRC dup guard for symmetry
is a possible future nicety, not a correctness fix.
