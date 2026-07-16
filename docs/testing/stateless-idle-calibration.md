# Stateless T_idle Calibration — Methodology

How to empirically ground the Time-to-Idle (`T_idle`) choice for stateless
hosts. Harness: `scripts/e2e/e2e-stateless-idle-calibration.sh`
(`make test-e2e-stateless-idle-calibration`).

**What answers what.** The harness does **not** pick a production `T_idle`.
By construction it certifies the *threshold mechanics* in both directions —
sub-`T` gaps must resume warm (never suspend), supra-`T` gaps must suspend
within the bounded window — and it certifies that the decision rule
(`smallest T with disruption_rate <= DISRUPTION_THRESHOLD`) runs correctly
over real measurements. Because the compressed local sweep fixes the
sub/supra mix by design, its `disruption_rate` is a constant and its
`recommendation.chosen_candidate_min` is expected to be `null` — that null
is *correct output*, not a gap. The production `T_idle*` itself comes from
the **transfer rule (§3)**: the p75–p90 quantile of the real per-Host
inter-message gap distribution, computed from `host_heartbeats.last_activity_ts`
deltas. §2 certifies the curve; §3 reads the answer off production data.

## 1. The idle rule and its knobs

The drain verdict is decided by `StatelessLifecycleTracker`:

```
drain = statelessEnabled && !activeWork && (now - lastActivityTs >= T_idle)
T_idle = max(idleMinutes, idleFloorMinutes)
```

| Knob | Source | Default | File:line |
|---|---|---|---|
| Idle rule + `T_idle` derivation | tracker doc comment / `idleMs` | — | `host-context-controller/src/statelessLifecycleTracker.ts:10-14`, `:220` |
| `idleMinutes` | env `CONTEXT_MAPPER_STATELESS_IDLE_MINUTES` | **30 min** | `host-context-controller/src/config.ts:524` |
| `idleFloorMinutes` | env `CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES` | **15 min** | `host-context-controller/src/config.ts:525` (tracker rejects `<= 0`: `statelessLifecycleTracker.ts:198-200`) |
| Drain grace | env `CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS` | 60 000 ms | `host-context-controller/src/config.ts:526` |
| HCC heartbeat poll | env `CONTEXT_MAPPER_HEARTBEAT_POLL_MS` | see parser | `host-context-controller/src/config.ts:528` (parser `:205-214`) |
| mcp-host heartbeat emitter | env `CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS` | 30 000 ms | `mcp-host/src/config.ts:252-264` — HCC does **not** inject it into host pods, so E2E always runs the 30 s cadence |

**Important**: `T_idle` is **not** a per-Host CRD field. `Host
spec.lifecycle` carries only `stateless: boolean`
(`charts/clerum-crds/crds/host.yaml`, lifecycle block). The threshold is
HCC-global env, so the harness sweeps candidates via `kubectl set env` on
the `host-context-controller` Deployment (floor pinned to 1, the legal
minimum, so the candidate governs) and restores the original values in its
cleanup trap — the same labeled-precondition mechanism
`e2e-stateless-suspend-wake.sh` uses.

## 2. Why local minikube can only validate curve mechanics

A CI-budget run cannot replay 30-minute human gaps. The harness therefore
compresses time: it sweeps small `T` candidates (default 1 and 2 min) and
expresses session gaps as **multiples of each candidate**
(`GAP_MULTIPLIERS`, default `0.5 1.5 3`). This preserves — and hard-asserts
— the *relative* geometry:

- gaps under 1×T must never suspend the host (violation = product bug, hard FAIL);
- gaps over 1×T must suspend within `T + emitter(30s) + drainGrace(20s) + poll(5s) + slack`;
- resume outcomes classify correctly (`warm_active` / `warm_cancel` / `cold_wake` with pod-UID evidence);
- recovery latency per outcome class and pod-uptime cost integrate correctly.

What compression **erases** is the production inter-message gap
distribution. Because gaps are defined relative to each candidate, every
candidate sees the same supra/sub mix, so the measured `disruption_rate` is
fixed by `GAP_MULTIPLIERS` *by construction*. The local sweep demonstrates
the decision rule operating on real measurements; it cannot pick the
production constant. That requires production gap data (§3).

## 3. Transfer function to production

```
T_idle* ≈ clamp( Q(p) of the production inter-message gap distribution per Host class,
                 lower = idleFloorMinutes,
                 upper = cost tolerance )        with p in [0.75, 0.90]
```

Rationale: if `T_idle` sits at the p75–p90 gap quantile, then 75–90 % of
consecutive-turn gaps resume warm (no suspend happened), and the forecast
`disruption_rate` = P(gap > T_idle) lands at 0.10–0.25, under the default
`DISRUPTION_THRESHOLD` of 0.34. Raising `T_idle` past p90 buys little UX
and costs linearly in pod uptime; dropping below p75 pushes cold wakes
(with their measured `p95_recovery_ms.cold_wake` penalty) onto live
conversations.

**Worked example — the 30-min hypothesis.** `T_idle = 30` is the right
*starting* default iff ~75–90 % of production session gaps are under
30 min. Post-deploy, measure it from the heartbeat plane: deltas of
`host_heartbeats.last_activity_ts` in control-plane Postgres, per hostRef:

```sql
-- inter-message gap quantiles per host, last 14 days
SELECT host_ref,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY gap_min) AS p75_min,
       percentile_cont(0.90) WITHIN GROUP (ORDER BY gap_min) AS p90_min,
       avg((gap_min > 30)::int) AS forecast_disruption_at_30m
FROM (
  SELECT host_ref,
         EXTRACT(EPOCH FROM (last_activity_ts
           - lag(last_activity_ts) OVER (PARTITION BY host_ref
                                         ORDER BY last_activity_ts))) / 60 AS gap_min
  FROM host_heartbeats
  WHERE last_activity_ts > now() - interval '14 days'
) g
WHERE gap_min > 0
GROUP BY host_ref;
```

Then apply the same decision rule the harness emits: smallest `T` whose
(forecast) `disruption_rate <= DISRUPTION_THRESHOLD`, clamped to
`[idleFloorMinutes, cost ceiling]`. If `forecast_disruption_at_30m` is
already ≤ 0.34 for a Host class, keep 30; if p90 is well under 30, a lower
`T_idle` saves uptime at no UX cost.

## 4. Running the harness

```bash
# prereqs: make minikube-setup && make minikube-pf-all (hold),
#          seeded chatllm-stateless (scripts/e2e/seed-stateless-host.sh)
make test-e2e-stateless-idle-calibration
# or explicitly:
KUBECONTEXT=clerum-test bash scripts/e2e/e2e-stateless-idle-calibration.sh
```

| Env | Default | Meaning |
|---|---|---|
| `IDLE_CANDIDATES_MIN` | `"1 2"` | T candidates, integer minutes (floor-legal ≥ 1) |
| `GAP_MULTIPLIERS` | `"0.5 1.5 3"` | Session gaps as multiples of T; values within ±10 % of 1× are rejected as unclassifiable |
| `EVENTS_PER_CANDIDATE` | `4` | Gaps replayed per candidate (multiplier cycle). Default is 4, not 6: with 6 the wall time is ~40 min, over the ~35 min budget; 4 lands ≈ 26 min. Set 6 explicitly for the denser sweep |
| `DISRUPTION_THRESHOLD` | `0.34` | Decision-rule cutoff on `disruption_rate` |
| `SUSPEND_DETECT_SLACK` | `90` | Seconds added to T for the supra-gap suspend bound (emitter 30 + grace 20 + poll 5 + reconcile slack) |
| `IDLE_CALIBRATION_OUT` | `/tmp/stateless-idle-calibration-<run>.json` | Output artifact path |
| Budgets | sibling-suite values | `E2E_TURN_TIMEOUT=120`, `POD_READY_TIMEOUT=180`, `WAKE_HOLD_DEADLINE=270` |

Wall-time estimate (the script prints it before the sweep):
`Σ_T (T × Σ cycled multipliers) + 2.5 min/candidate overhead + 2 min prereq`.
Defaults: `(1+2) × 5.5 + 5 + 2 ≈ 24–26 min`.

## 5. Reading the JSON

Top level: `run_id`, `scope: "compressed-local"`, `candidates[]`,
`recommendation`.

Per candidate:

| Field | Meaning |
|---|---|
| `resumes` | Measured resume turns (= events) |
| `suspend_count` | Suspensions observed during supra gaps |
| `cold_wake_count` / `warm_cancel_count` / `warm_active_count` | Outcome classes: state at send was `suspended` (podUid changed) / `draining` (podUid unchanged) / `active` |
| `disruption_rate` | `cold_wake_count / resumes` — fixed by the multiplier mix locally (§2) |
| `p95_recovery_ms.{cold_wake,warm_cancel,warm_active}` | Nearest-rank p95 of send→definitive-200 latency per class — the real signal to compare across candidates |
| `pod_uptime_seconds` / `wall_seconds` / `uptime_ratio` | 5 s-sampled Running-pod integration — the cost proxy; smaller T ⇒ lower ratio |
| `events[]` | Raw per-event records |

`recommendation` applies `smallest T with disruption_rate <=
DISRUPTION_THRESHOLD` to the measured data, is labeled
`scope: "compressed-local"`, and echoes the §3 transfer rule. With the
default multiplier mix `chosen_candidate_min` is expected to be `null`
(rates are 0.5 by construction) — the decision that matters is made on
production gap quantiles, and the local run certifies the mechanics that
decision relies on.
