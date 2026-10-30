# Egress proxy CDN rotation E2E (issue #549)

`scripts/e2e/e2e-egress-cdn-rotation.sh` proves, on a branch-owned minikube
profile with real Calico, a real host-context-controller (HCC) and real TLS to
CloudFront, that the remote egress proxy keeps working when a CDN host rotates
its answer set and the old set leaves the exact-host NetworkPolicy.

It is a **manual** gate. It is not part of T0/T1/T2 and not part of CI: it
rewrites cluster DNS, restarts HCC and needs Internet access.

## What it proves

The script runs two proxies for the same host (`mcp.airtable.com` by default),
the same image and the same NetworkPolicy:

- the **branch proxy**, rendered by HCC with `server <host>:443 resolve;`, must
  follow the answer-set changes with no pod restart;
- the **control proxy**, rendered from the same HCC ConfigMap with one verified
  transformation (`proxy_pass https://remote_upstream…;` becomes
  `proxy_pass https://<host>…;`, the `dev` template shape), must stop serving
  while its pinned set is outside the policy and recover when the set returns,
  with no pod restart.

The control is the causality witness: only the template differs, so a failure
of the branch proxy while the policy equals the new set cannot be blamed on the
CDN. The script validates set B with the branch proxy's own cold start (phase 3)
and set A with the control's cold start (phase 4) before it measures anything.
From that point a branch failure with the policy exactly equal to the new set is
a product failure (exit 1), not an inconclusive result.

## Prerequisites

- A healthy, bootstrapped branch-owned minikube profile with Calico, HCC and the
  branch `nginx-egress-proxy` image already deployed (the normal precondition is
  a green T0/T1 lane on the same HEAD).
- Internet access from the profile; CloudFront must answer the CDN host.
- `jq` and `python3` on the host, `curl` in the proxy image (the script checks
  `curl --version` in each pod before probing).
- The `deny-all-mcp-server` NetworkPolicy (empty `podSelector`, `Egress`) in
  `mcp-server`; this is the T2 HCC contract shape.
- No leftovers from an aborted run: no `HCC_EXTERNAL_EGRESS_OVERLAP_SEC` in the
  HCC env, no `clerum.io/e2e-temporary-override` annotation, no CDN host row in
  the CoreDNS `hosts` block, no `e2e-cdn-rotation*` resources. The script refuses
  to start otherwise.
- `host-context-controller`, `nginx-egress-proxy` and
  `packages/network-policy-core` must be identical to the git HEAD recorded by
  the pre-gate marker (`clerum-pre-gate-sync-state`), so a green run describes
  the code that is actually deployed.

## Collect `CDN_SET_A` and `CDN_SET_B`

The two sets are the four public IPv4 addresses CloudFront answered for the host
at two different moments. They expire, so there is no default. Watch the answer
and record two complete, disjoint answers:

```bash
while true; do
  date +%T
  dig +short A mcp.airtable.com @1.1.1.1 | sort
  sleep 30
done
```

Observed on 2026-10-30:

```text
A = 18.154.48.13 18.154.48.20 18.154.48.43 18.154.48.50
B = 18.172.153.11 18.172.153.14 18.172.153.41 18.172.153.115
```

Each variable must list exactly four distinct public IPv4 addresses in dotted
decimal without leading zeros; commas or spaces are accepted. Duplicates,
private, loopback, link-local, CGNAT, documentation and multicast addresses are
rejected before anything is mutated.

## Run

```bash
CONTEXT=<branch-scoped-context>          # clerum-<branch>-<8 hex>
EVIDENCE=.local-notes/infra/runs/egress-cdn-rotation/$(date +%Y%m%dT%H%M%S)

MINIKUBE_PROFILE="$CONTEXT" \
CONTROL_API_REAL_PG_CONTEXT="$CONTEXT" \
KUBECONTEXT="$CONTEXT" \
CDN_SET_A="18.154.48.13 18.154.48.20 18.154.48.43 18.154.48.50" \
CDN_SET_B="18.172.153.11 18.172.153.14 18.172.153.41 18.172.153.115" \
E2E_CDN_EVIDENCE_DIR="$EVIDENCE" \
  bash scripts/minikube/with-t2-mutation-lock.sh -- \
    bash scripts/e2e/e2e-egress-cdn-rotation.sh
```

`E2E_CDN_EVIDENCE_DIR` (or the first argument) is required: the script writes no
ephemeral fallback. `KUBECONTEXT`, `MINIKUBE_PROFILE` and
`CONTROL_API_REAL_PG_CONTEXT` must be the same value; the first script step is
`scripts/minikube/require-t2-mutation-lock.sh`, so an unleased or unbootstrapped
profile fails as a precondition instead of mutating the cluster.

`E2E_CDN_MUTATION` is empty for a normal run. The two vacuity mutations must fail
with a specific REASON (see below):

- `control-uses-fixed-template`: the control keeps the branch template, follows
  set B and never fails in phase 5;
- `branch-probe-reads-control`: from phase 5 the branch probe `exec`s into the
  control pod (branch UID, `startedAt` and `restartCount` are still read from the
  branch pod), so the branch samples fail after the prune.

## Phases

| Phase | What happens | Bounded failure |
| ----- | ------------ | --------------- |
| 0 | Inputs, ownership, lease, cluster prerequisites, leftovers, pre-gate marker and source diff, evidence setup | exit 2, nothing mutated |
| 1 | HCC `HCC_EXTERNAL_EGRESS_OVERLAP_SEC=60`, `HCC_EXTERNAL_EGRESS_RESYNC_SEC=10`, rollout, startup resync log witness | exit 2 |
| 2 | CoreDNS `hosts` block = set B with `ttl 5`; `resolve4` inside the HCC pod must return exactly B with ttl <= 5 (<= 150 s) | exit 3 |
| 3 | Create the `e2e-cdn-rotation` McpServer; every `egress-fqdn-state` entry must satisfy `expiresAt - lastObservedAt <= 65 000 ms`; policy exactly B (<= 90 s); the branch proxy answers through CloudFront (<= 120 s from Ready) | 2 for the window witness, 3 otherwise |
| 4 | CoreDNS = A; HCC sees A (<= 150 s); `t_dns` = first A `lastObservedAt`; policy exactly A (<= `t_dns` + 90 s); create the control, which must answer through CloudFront (<= 120 s from Ready); then the branch must have 0 failures with the policy exactly A, and at most 1 failure in the transition | 3 for A/DNS/policy/control; 1 for the branch |
| 5 | CoreDNS = B; same DNS/policy deadlines; the branch must have 0 failures with the policy exactly B (at most 1 in the transition); the control must reach 3 consecutive failures within 120 s of the prune | 3 for B/DNS/policy; 1 for the branch or the control |
| 6 | CoreDNS = A; same deadlines; the control must answer again within 60 s of policy = A; the branch must have 0 failures with the policy exactly A | 3 for A/DNS/policy; 1 for the branch or the control |
| 7 | Delete the McpServer and the control, wait for the Deployment, ConfigMap and `ext-egress` policy to disappear, restore HCC and the Corefile, verify both | exit 4 |

Timings are deliberately conservative because of HCC's re-resolution cadence.
With `ttl 5` the effective cadence is 5 s (`externalEgressResyncDelayMs` clamps to
`min(configured, TTL/2)` with a 5 s floor), even though HCC's startup log always
says "every 10s". The prune arrives between roughly `t_dns + 25 s` and
`t_dns + 70 s`; the deadlines above include that margin. There is no global
timeout: each step has its own bound.

## Exit codes and the verdict line

The last stdout line is always:

```text
E2E_CDN_ROTATION_VERDICT=<PASS|FAIL|PRECONDITION|INCONCLUSIVE|RESTORE_FAILED> EXIT=<n> REASON=<id>
```

Read the verdict from that line, not from the wrapper's exit status (the
mutation-lock wrapper can replace a 0 with its own release failure).

| Exit | Verdict | Meaning |
| ---- | ------- | ------- |
| 0 | `PASS` | The branch rotated and the control failed then recovered. |
| 1 | `FAIL` | A product assertion failed. |
| 2 | `PRECONDITION` | Inputs, ownership, lease, prerequisites, leftovers or a harness witness were wrong; nothing was measured. |
| 3 | `INCONCLUSIVE` | Set B or A could not be validated, or a probe had no network result. Not a product verdict; repeat the run. |
| 4 | `RESTORE_FAILED` | The profile was not restored; takes precedence over every other code. |

### REASON ids

Each id names one check; where a check has more than one step, its row lists
every step. Preconditions (exit 2):

| REASON | Failed assertion |
| ------ | ---------------- |
| `usage` | Arguments, evidence directory, mutation name, host name or address sets |
| `tooling-missing` | `jq` or `python3` missing on the host |
| `context-not-owned` | `KUBECONTEXT` is not a branch-scoped context or does not match the profile/context variables |
| `lock-not-held` | `scripts/minikube/require-t2-mutation-lock.sh` refused the inherited lease |
| `cluster-prerequisites` | HCC, CoreDNS, the McpServer CRD or `deny-all-mcp-server` missing (`deny-all-mcp-server` must be an empty-selector `Egress` default deny), the HCC container missing from the Deployment, or the HCC Deployment or the Corefile could not be read |
| `leftover-state` | A previous run left an override, a `hosts` row or a test resource |
| `corefile-unexpected` | The Corefile is empty or does not have exactly one multi-line `hosts` block |
| `marker-missing` | The pre-gate marker has no usable `gitHead` |
| `source-drift` | The code under test differs from the marker HEAD |
| `hcc-env-not-applied` | The HCC override annotation, env, rollout, env read-back or startup resync log witness failed |
| `window-witness` | HCC did not write the `ext-egress` policy with its `egress-fqdn-state` annotation within 60 s, the annotation could not be read back, or an entry kept a longer overlap than 65 s (only this last step writes `window-witness-violation.json`) |
| `curl-missing` | `curl --version` failed in a proxy pod |
| `control-template-witness` | The control's `proxy_pass` transformation of the branch template, or the `default.conf` rendered in the control pod (unreadable or not in the expected form), is wrong |
| `corefile-not-applied` | The override Corefile could not be rendered or does not contain every row and `ttl 5`, or the CoreDNS patch, read-back or annotation check failed |

Inconclusive (exit 3): `phase2-dns-set-b-not-visible`,
`phase3-policy-b-not-converged`, `phase3-branch-not-ready`,
`phase3-branch-not-serving-b`, `phase4-dns-set-a-not-visible`,
`phase4-policy-a-not-converged`, `phase4-control-not-ready`,
`phase4-control-not-serving-a`, `phase5-dns-set-b-not-visible`,
`phase5-policy-b-not-converged`, `phase6-dns-set-a-not-visible`,
`phase6-policy-a-not-converged`, `control-pod-replaced`,
`upstream-rate-limited` (the upstream answered 403/429), `probe-unavailable`
(only executor errors, no network result to judge), `policy-loop-missing`,
`interrupted` and `unexpected-error`.

These inconclusive ids cover more than one step:

| REASON | What failed |
| ------ | ----------- |
| `phase3-policy-b-not-converged` | The McpServer could not be applied, or the policy was not exactly B within 90 s |
| `phase4-policy-a-not-converged`, `phase5-policy-b-not-converged`, `phase6-policy-a-not-converged` | HCC recorded no address of the new set in `egress-fqdn-state` within 150 s, `t_dns` was not a timestamp, or the policy was not exactly the new set within `t_dns` + 90 s |
| `phase3-branch-not-ready` | The branch proxy pod did not become Ready, or its baseline identity could not be read |
| `phase4-control-not-ready` | The control ConfigMap or Deployment could not be created, the control pod did not become Ready, or its baseline identity could not be read |

Product failures (exit 1):

| REASON | Failed assertion |
| ------ | ---------------- |
| `branch-pod-replaced` | Branch pod UID, `startedAt` or `restartCount` changed |
| `branch-pinned-old-set` | Branch failure in phase 4 with the policy exactly A |
| `branch-transition-failures` | More than 1 branch failure in a `[CoreDNS patch, policy = new set)` window |
| `branch-failed-after-prune` | Branch failure in phase 5 with the policy exactly B |
| `branch-failed-after-recovery` | Branch failure in phase 6 with the policy exactly A |
| `control-did-not-fail` | The control did not reach 3 consecutive failures within 120 s of the prune |
| `control-did-not-recover` | The control did not answer within 60 s of policy = A |

Restoration (exit 4): `restore-failed`.

Vacuity expectations: a normal run is `PASS REASON=none`;
`control-uses-fixed-template` must be `FAIL ... REASON=control-did-not-fail`;
`branch-probe-reads-control` must be
`FAIL ... REASON=branch-failed-after-prune`.

## What is temporarily changed, and how it is restored

Only two objects are modified, both with the annotation
`clerum.io/e2e-temporary-override: e2e-egress-cdn-rotation` in
`metadata.annotations` (never in a pod template):

1. **HCC Deployment** `control-plane/host-context-controller`: adds
   `HCC_EXTERNAL_EGRESS_OVERLAP_SEC=60` and `HCC_EXTERNAL_EGRESS_RESYNC_SEC=10`.
   The original container `env` array is saved as one JSON array and restored
   with a JSON patch, then compared as the full JSON (order and presence). HCC
   rolls out (its strategy is `Recreate`).
2. **CoreDNS ConfigMap** `kube-system/coredns`: adds `ttl 5` and four
   `<ip> <CDN_HOST>` rows to the single existing `hosts` block. The whole
   Corefile is saved and restored byte for byte; CoreDNS reloads itself, it is
   never restarted, so cluster DNS is not interrupted.

The script verifies the restored ConfigMap, not what CoreDNS serves. CoreDNS
serves the restored Corefile only after the kubelet refreshes the mounted
ConfigMap and the `reload` plugin detects the change. On the 2026-10-30 runs an
override became visible to HCC's resolver 23-99 s after the patch (including
HCC's 5 s sampling), and phases 2, 4, 5 and 6 wait up to 150 s
(`DNS_VISIBLE_TIMEOUT`) before they fail. The script does not wait for that
propagation after the restore, so until then cluster DNS can still answer
`CDN_HOST` from the test rows.

Cleanup order: delete the McpServer and the control, wait until the Deployment,
ConfigMap and `ext-egress` NetworkPolicy are gone, restore HCC, restore the
Corefile, then verify the env JSON, the Corefile bytes, the removal of the
annotations and that no NetworkPolicy with
`clerum.io/mcpserver=e2e-cdn-rotation` remains. Only then is `PASS` possible.

Side effects while the run lasts:

- `ttl 5` applies to every row of the `hosts` block, including
  `host.minikube.internal`;
- with overlap 60, every exact-host egress binding of the profile uses the short
  window; phase 0 lists the existing bindings in
  `existing-exact-host-bindings.txt`.

## If the run ends with `RESTORE_FAILED`

The profile is still modified. The script prints the exact repair commands to
stderr and appends them to `manual-repair.txt` in the evidence directory, next
to the saved originals (`hcc-env-restore.json`, `corefile-original.txt`). Run
them with an explicit `--context`. A retry refuses to start while an override is
still present (`leftover-state`), so repair before re-running.

## What it does not cover

- **Split-view resolvers**: the test gives HCC and NGINX the same CoreDNS
  answers. Production can have HCC and a proxy see different recursive answers
  for a while; that residual is measured by the F2/F3 dev/prod runs, not here.
- **GKE, dev or prod**: this is Calico on minikube, not GKE certification, and
  it touches no shared cluster.
- **Natural multi-hour rotation**: the rotation is scripted from two observed
  answer sets; the rate of real CloudFront changes is a different measurement.
- **The rest of the proxy contract**: TLS, the DNS switch and query placeholders
  are covered by `scripts/tests/test-nginx-egress-proxy-tls.sh` and the HCC
  unit tests.
