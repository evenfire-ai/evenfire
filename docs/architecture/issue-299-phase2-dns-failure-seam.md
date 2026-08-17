# Provider-CIDR egress under DNS failure — the seam rule (issue #299 Phase 2)

**Status:** AUTHORITATIVE design record. Settles the recurring churn between commit `b0b41c8e`
(round 3, WRC catalog-on-permanent-failure exemption) and its revert `36b36497` (round 4).
Round 3's goal was correct; its implementation had an fqdn-keyed leak. Round 4 removed the
leak **and** the goal, justifying the removal with a claimed HCC symmetry that does not exist
(`36b36497` touched zero HCC lines). This record fixes WRC to HCC's *actual* shipped behavior
and closes the round-4 leak structurally. Produced from a two-agent adversarial analysis
(author + red-team), red-team verdict **GO** conditional on the guards in §3.

## 1. The problem

A `provider` egress binding declares intent (`provider: {name, categories}`); the controller
resolves catalog CIDRs from the `clerum-provider-netblocks` ConfigMap, **independent of DNS**.
The catalog exists precisely because per-controller DNS is unreliable (the #299 root cause).
There is *also* a per-binding DNS resolution feeding a residual `/32` sliding window.

On a `provider` binding whose FQDN gives a **permanent, non-blocked** DNS answer
(NXDOMAIN / ENOTFOUND / ENODATA / empty) at cold start (no prior NetworkPolicy):

- **HCC renders the catalog.** The catch at `host-context-controller/src/networkPolicyReconciler.ts:1225-1271`
  accumulates with `providerRanges`; the core composes `cidrs = providerRanges ∪ residual`
  unconditionally (`host-context-controller/src/externalEgressAccumulator.ts:138`), so
  `cidrs = providerRanges` (non-empty) → NP rendered, `console.warn` only.
- **WRC renders nothing.** It throws (`workflow-recipes/src/reconciler/workflowRecipeReconciler.ts:4137-4143`
  ui, `:4634-4640` workload) **before** `resolveProviderRangesPerDeclaration` is ever called
  → empty egress → provider mode defeated at bootstrap on exactly the failure it exists to survive.

HCC and WRC agree only on a **blocked** answer (both fail loud). The "symmetric with HCC by
design" claim in the WRC comments and `docs/provider-cidr-egress.md` is factually wrong for the
**absent** case.

## 2. Invariant R1 — the seam rule, stated once

> **R1.** For every egress declaration `D` on every reconcile, the rendered grant is
> `render(D) = catalog(D) ∪ window(D)`, where:
> - **`catalog(D)`** depends **only** on declaration validity, the curated registry row, the
>   `clerum-provider-netblocks` ConfigMap, and the provider bounds — **never on DNS**. Non-empty
>   iff `D` is provider-mode and catalog resolution succeeded.
> - **`window(D)`** (residual `/32` sliding window) depends **only** on the DNS outcome:
>   `ok` → fold fresh validated IPs; `transient` → freeze (H1); `permanent-absent` → natural
>   expiry (ttl+overlap), no freeze.
> - **Tripwire:** if any fresh answer for `D` is **blocked** (private/blocked-CIDR), or `D` is
>   provider-mode with an unresolvable/invalid/empty catalog, do **not** author a fresh policy
>   for that scope: fail loud, retain the live policy (LKG) if one exists.
> - **Emptiness gate:** if `⋃ render(D)` over the policy's declarations is empty and any failure
>   occurred this round, do not author: fail loud, retain LKG.

DNS outcomes gate **only the window**. A permanent-**absent** answer never gates catalog
rendering; a **blocked** answer always fails loud. This is HCC's shipped behavior; WRC is brought to it.

### Decision table (**R** = render `catalog∪window`; **F** = fail-loud, author nothing; **L** = fail-loud + retain LKG)

| # | Binding class | DNS outcome | Cold start (no live NP) | Steady state (live NP) |
|---|---|---|---|---|
| 1 | exact-host | ok | R (window only) | R (window only) |
| 2 | exact-host | transient | F (degraded/retry) | L/R (frozen window, H1) |
| 3 | exact-host | permanent-absent | F (terminal `failed`) — **unchanged** | L/R (loud, LKG kept) — mechanism differs HCC vs WRC, documented, out of scope |
| 4 | exact-host | permanent-blocked | F | L |
| 5 | provider (valid catalog) | ok | R + drift canary | R + drift canary |
| 6 | provider (valid catalog) | transient | R (catalog-only) — already shipped both sides | R (catalog ∪ frozen window) |
| 7 | **provider (valid catalog)** | **permanent-absent** | **R (catalog-only) + exempted-metric/warn ← THE FIX** | R (catalog ∪ decaying window) + exempted-metric/warn |
| 8 | provider (valid catalog) | permanent-blocked | F | L (never render fresh off a blocked answer) |
| 9 | provider (empty/invalid catalog, or CM unavailable) | any | F | L |

**Row 7 is the only behavioral change, and only in WRC.** It makes WRC identical to HCC.

## 3. Non-negotiable guards (red-team gating conditions — absent (G1) or (G2) this is NO-GO)

- **G1 — structured discriminator, never string-matching.** Add `failureKind: 'transient' | 'absent' | 'blocked'`
  to `ResolveResult.failures` (`workflow-recipes/src/reconciler/fqdnResolver.ts:184`), set at the
  two *classification* sites (they are structurally different code paths, so the flag is
  trustworthy by construction and can never be produced by parsing an error string):
  - blocked filter branch (`fqdnResolver.ts:~224-231`, successful resolution + `isBlockedExternalIPv4`) → `'blocked'`.
  - error branch (`~216-222`, resolver error) → `'transient'` if `retryable`, else `'absent'`.
  The exemption keys on `failureKind === 'absent'` only. (An *unknown* DNS code classifies
  `'permanent'`→`'absent'`→catalog render — exactly HCC's `:1229` behavior; acceptable because the
  grant is the pre-approved catalog.)
- **G2 — positional `every`-quantifier over the render-governing `providerRanges` array**
  (closes the round-4 leak structurally). Exempt fqdn `F` from the throw iff:
  ```
  F is exempt  ⇔  failureKind === 'absent'
              ∧  externals.some((e,i) => e.fqdn === F && (providerRanges[i]?.length ?? 0) > 0)
              ∧  externals.every((e,i) => e.fqdn !== F || (providerRanges[i]?.length ?? 0) > 0)
  ```
  Quantify over **declarations positionally** using the index-aligned `providerRanges` from
  `resolveProviderRangesPerDeclaration` (positional per PR335-WRC-002). Do **not** build a Set of
  fqdns (round-3's bug) and do **not** re-derive provider-ness from `e.provider`. One exact-host
  sibling on the same fqdn (`providerRanges[i]` empty) → `every` fails → throw.
- **G3 — observability replaces the lost phase signal (MED-3).** The exemption removes the
  terminal `failed` phase, and the drift canary goes dark on non-`ok` resolutions, so the
  catalog-only-despite-DNS-failure state must have its own durable, alertable signal.
  **Shipped mechanism (drift-canary parity):** (1) a Prometheus counter
  `externalEgressPermanentDnsExemptedTotal{recipe,fqdn}` — the primary alertable operator signal,
  at the same tier as `externalEgressProviderDriftTotal`; (2) a **throttled** `console.warn`
  (mirror `warnProviderDrift`'s 1h throttle — avoids per-60s-refresh log churn). This deliberately
  matches the EXISTING, reviewed observability contract for the analogous "provider egress anomaly"
  (the drift canary ships metric + throttled warn and NO status condition), rather than inventing a
  new tier. A richer `status.conditions[]` surface is a possible future addition but is **not**
  required here: threading a condition through the two large reconcile functions' many
  `ReconcileResult` return sites is invasive on a security-sensitive crown-jewel path, and the
  metric already satisfies MED-3's core demand ("not just `console.warn`"). WRC emits no k8s
  Events — do not add an Event path.
- **G4 — one shared helper across both gates (MED-4).** The predicate + filtered-throw must land
  identically at the ui gate (`:4137`) and workload gate (`:4634`), including moving
  `resolveProviderRangesPerDeclaration` **before** each gate. Extract a single helper; a test per path.
- **G5 — filter-then-throw-on-remainder (MED-5).** `fatal = permanentFailures.filter(f => !exempt(f))`;
  throw if any remain. A blocked provider fqdn keeps the **whole-policy** throw (H3-by-throw retains
  the live NP) — even an exempted absent sibling does not render that round. Fail-close, not a leak.

### Safety constraints (upheld by construction)
Never render `0.0.0.0/0` / uncurated egress (catalog only ever from `resolveProviderRanges`, bounds-validated).
Catalog re-validated every reconcile, never rehydrated from the provenance annotation (M3 blocked
filter stays on the exempted branch). Blocked answer still fails loud (G1). Co-declared exact-host
still fail-closes (G2). Exact-host-only permanent failure unchanged (row 3). Emptiness gate
(`acc.resolved.length === 0 && failures.length > 0`) stays as last line of defense.

## 4. Control flow (both paths, via the G4 shared helper)

Reorder: resolve provider ranges **before** the permanent-failure gate (CM-unavailable → retryable
throw → LKG; invalid catalog → terminal throw → row 9 — so by the time the exemption runs, every
provider declaration has non-empty canonical ranges). Then replace the unconditional throw with the
G5 filter using the G2 predicate. No accumulator or core changes: `buildObservations` already emits
`kind:'permanent'`, the core expires those entries normally, and `rangeRules` render regardless of
window state — once the throw stops firing first, WRC produces exactly HCC's `catalog ∪ decaying-residual`.

## 5. The decay trade-off — explicit, accepted

Under sustained permanent DNS failure a provider binding's residual `/32`s expire after ttl+overlap
and the grant decays to **catalog-only**, breaking egress to drifted (out-of-catalog) endpoints.
**HCC already behaves exactly this way** (same `'permanent'` kind, same core), so this is symmetry,
not regression. Every drifted IP was flagged at entry by the drift canary; the
`clerum_wrc_external_egress_permanent_dns_exempted_total` metric + a throttled warn mark the decay
window (G3, drift-canary parity). The catalog is the declared
intent; drifted `/32`s are anomalies with a deliberately bounded lifetime; with DNS down no new drift
can be discovered anyway; the alternative (freeze forever) breaks the sliding-window liveness bound
that is the point of #299. **Accepted.**

## 6. Test matrix (TDD — each fix test shown RED against current code first)

- **Unit `fqdnResolver.test.ts`:** blocked answer → `failureKind:'blocked'`; NXDOMAIN/ENODATA/empty →
  `'absent'`; transient → `'transient'`.
- **Unit reconciler (row #s), implemented in `reconciler.test.ts`:** T1/T2 (row 7, ui + workload,
  permanent-absent, no NP → NP with catalog CIDRs + provenance, phase ≠ `failed`; RED verified by
  mutation); T3 (row 8 blocked → throw, no NP); **T4 (round-4 guard):** same fqdn provider + exact-host
  different port, permanent-absent → throw, **both declaration orders**; T8 (row 9 invalid/empty catalog
  + absent → throw). (T5 exact-host-only-absent → terminal, T10 all-transient → degraded, and the T6
  decay path are covered by the pre-existing accumulator/reconciler suites, unchanged by this fix.)
- **E2E `scripts/e2e/e2e-provider-cidr-egress.sh` (GATE 2/3):** optional future **Phase 4c** — provider
  binding on an unresolvable fixture fqdn → NP with catalog CIDRs, provenance grep passes, phase ≠
  `failed`, `clerum_wrc_external_egress_permanent_dns_exempted_total` incremented; negative twin with a
  co-declared exact-host sibling → phase `failed`. Phases 6 (H3-live) and 7 (enforcement) stay green
  unmodified; the existing gate re-run proves no regression.

## 7. Docs + diagram deltas

- `workflowRecipeReconciler.ts` ui comment and workload comment: replace the false "symmetric with
  HCC by design" claim with R1 (blocked → throw; absent + all-provider → catalog renders + exempted
  metric/warn); cite this record. **Done.**
- `docs/provider-cidr-egress.md` "Known limitation" section: rewritten — the limitation is now
  **blocked-only**; documents R1, the absent/blocked split, the co-declared exact-host guard, the
  exempted metric, and decay-to-catalog; the "implemented and reverted within this milestone" line is
  deleted. **Done.**
- Architecture diagram (`.local-notes/issue-299-phase2-architecture.{svg,png,html}`,
  `docs/assets/issue-299-phase2-architecture.svg`): the WRC "permanent failure → throw" branch splits
  into `permanent-blocked → throw` and `permanent-absent ∧ all-provider → render catalog`; HCC branch
  unchanged.

## 8. Rollback

Single `git revert` of the implementing commit restores throw-first ordering. Safe: no CRD/schema
change; provenance annotation format untouched (no migration, e2e greps unaffected); `failureKind`
and the condition type are additive. Follows the existing ordering in `docs/provider-cidr-egress.md`
("Rollback": controllers before core, never while provider bindings exist).
