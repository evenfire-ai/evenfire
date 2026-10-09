# Prove the install and hand over

Source the env file and pin `--context` on every command. Every check below
fails loudly; an empty result is never a pass.

## 1. Rollout (required)

```bash
. "$HOME/.evenfire-doks/env.sh"
cd "$REPO_DIR"
kubectl kustomize deploy/overlays/digitalocean-doks > "$WORK/render.yaml"
ruby -ryaml -e 'YAML.load_stream(File.read(ARGV[0])).compact.each { |d| puts "#{d["metadata"]["namespace"]}/#{d["metadata"]["name"]}" if d["kind"] == "Deployment" }' "$WORK/render.yaml" \
  | while IFS=/ read -r ns name; do
      kubectl --context "$CONTEXT" -n "$ns" rollout status "deployment/$name" --timeout=300s >/dev/null 2>&1 \
        && echo "PASS $ns/$name" || echo "FAIL $ns/$name"
    done
kubectl --context "$CONTEXT" get pods -A \
  -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{" "}{.status.containerStatuses[*].state.waiting.reason}{" "}{.status.containerStatuses[*].restartCount}{"\n"}{end}' \
  | grep -E '^(channels|control-plane|gfs|ingress|llm-hooks|mcp-host|mcp-server|profiles|rpc-proxy|sandbox-recipes|sandbox-ui|webhook-ingress)/' \
  | grep -E 'CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainer'
```

Pass criteria, each by exact name (an empty result is never a pass):

- Every Deployment in the render is rolled out. At the validated release those are:
  - `control-plane`: `codex-llm-proxy`, `control-api`, `control-api-rpc-gateway`,
    `control-postgres`, `control-ui`, `grok-llm-proxy`,
    `host-context-controller`, `host-context-controller-api-gateway`,
    `nginx-workflow-approval-gateway`, `trace-maintenance-worker`,
    `workflow-recipes`
  - `channels`: `clerum-workflow-approval-request-reader`
  - `mcp-server`: `mcp-proxy`
  - `profiles`: `external-rest-api`, `profile-control-funnel`, `profile-ui`
  - `rpc-proxy`: `rpc-proxy`
  - `webhook-ingress`: `webhook-proxy`
  - `ingress`: `cloudflared` (Variant B only)
- One HCC-spawned Deployment per Host (named after the Host, in `mcp-host`), plus
  `gfs/gfsc-writer` and `gfs/gfsc-reader`, are rolled out. A Host whose
  `secretRef` Secret is missing is pending the human (the LLM key, guide Phase 6):
  HCC logs "Host Secret not found; Host will not be deployed" and creates no
  Deployment. Before Phase 6 that is expected; in Phase 8 it is not.
- `kubectl -n gfs get globalfilesystem gfs -o jsonpath='{.status.phase}'` is `Ready`.
- The last command prints nothing: no container waiting in `CrashLoopBackOff`,
  `ImagePullBackOff`, `ErrImagePull`, or `CreateContainer*`. Also check that no
  container has more than 5 restarts; pod phase alone hides crash loops.

## 2. Network isolation (required)

```bash
. "$HOME/.evenfire-doks/env.sh"
cd "$REPO_DIR"
bash deploy/scripts/verify-networkpolicies.sh --overlay digitalocean-doks --context "$CONTEXT"
CONTEXT="$CONTEXT" OVERLAY=digitalocean-doks bash deploy/scripts/np-enforce-preflight.sh
```

- `verify-networkpolicies.sh` renders the overlay, fails if the base placeholder
  `10.109.0.1/32` is still rendered, and checks every rendered NetworkPolicy
  exists live. It ignores CiliumNetworkPolicies (section 3 checks those).
- The preflight's only acceptable FAIL lines are check 3 for `gfs` and
  `llm-hooks` (see [quirks.md](quirks.md#np-enforce-preflightsh-on-doks)). Any
  other FAIL is a stop.
- Repeat the guide's Phase 0.1 NetworkPolicy deny check (owned and bare pod both
  denied).

Record whether WRC runs `CONFIRMED=true` (guide 5.14 conditions met, human
agreed) or stays `false`, where recipes with external egress are refused.

## 3. Kubernetes API egress (required)

```bash
. "$HOME/.evenfire-doks/env.sh"
for ns in control-plane channels mcp-host mcp-server sandbox-recipes rpc-proxy; do
  kubectl --context "$CONTEXT" -n "$ns" get ciliumnetworkpolicy "allow-k8s-api-egress-cilium-$ns" -o name \
    || echo "FAIL missing CiliumNetworkPolicy in $ns"
done
```

All six CiliumNetworkPolicies must exist by name. Their `.status` only reports
that the policy passed validation (a `Valid` condition), not that it is
enforced, so do not gate on it. Repeat the Phase 0.1 API egress check; record
`API_EGRESS_PATH`. HCC and WRC both Ready (section 1) is the platform-level proof
that API egress works for the real workloads.

## 4. JWT chain (required, no key material printed)

```bash
. "$HOME/.evenfire-doks/env.sh"
a="$(kubectl --context "$CONTEXT" -n rpc-proxy get secret rpc-proxy-secrets -o jsonpath='{.data.RPC_PROXY_JWT_PUBLIC_KEY}' | base64 -d | openssl dgst -sha256 | awk '{print $NF}')"
b="$(kubectl --context "$CONTEXT" -n mcp-host get configmap mcp-host-config -o jsonpath='{.data.CLERUM_AUTH_JWT_PUBLIC_KEY}' | openssl dgst -sha256 | awk '{print $NF}')"
c="$(kubectl --context "$CONTEXT" -n gfs get configmap gfs-config -o jsonpath='{.data.jwt-public-key}' | openssl dgst -sha256 | awk '{print $NF}')"
empty="$(printf '' | openssl dgst -sha256 | awk '{print $NF}')"
if [ "$a" != "$empty" ] && [ "$a" = "$b" ]; then echo 'PASS mcp-host-config key matches'; else echo 'FAIL mcp-host-config key'; fi
if [ "$a" != "$empty" ] && [ "$a" = "$c" ]; then echo 'PASS gfs-config key matches'; else echo 'FAIL gfs-config key'; fi
```

Only digests are printed. On FAIL, re-run `provision-gfs-runtime.sh` (guide 5.12).

## 5. HTTP health

Internal (ask before opening local ports). Each port-forward goes in its own
terminal. Set `LOCAL` to the loopback address that forward listens on (for the
first row, `LOCAL=127.0.0.1:18090`):

| Service | Port-forward | Check |
| --- | --- | --- |
| control-api | `-n control-plane service/control-api 18090:8090` | `curl -fsS "http://$LOCAL/health"` |
| external-rest-api | `-n profiles service/external-rest-api 18091:8091` | `curl -fsS "http://$LOCAL/health"` |
| rpc-proxy | `-n rpc-proxy service/rpc-proxy 18094:8094` | `curl -fsS "http://$LOCAL/health"` |
| control-ui | `-n control-plane service/control-ui 13000:3000` | `curl -fsS -o /dev/null -w '%{http_code}' "http://$LOCAL/"` is `200` or a redirect |

With ingress live, check the five public HTTPS hostnames instead and confirm TLS
is valid.

## 6. Admin and LLM key (HUMAN)

- The human claimed the admin account through the port-forward (guide Phase 6)
  and can log in to Control UI. The agent never saw the password.
- The human entered the LLM key in Control UI → Secrets → LLM. A Host chat
  request succeeds from Control UI or the Desktop app.

## 7. DigitalOcean readiness (report only)

Ask the human to run the cluster's Operational Readiness Check (clusterlint) and
paste the Evenfire findings. Report them; do not change workloads
([quirks.md](quirks.md#clusterlint-findings-report-them-do-not-rewrite-workloads)).

## Handover block (print this)

```text
Evenfire DOKS install
- doctl context / team:
- cluster / region / version / HA / VPC-native:
- kube context:
- release: RELEASE_TAG=      (validated release: )
- overlay: deploy/overlays/digitalocean-doks in <REPO_DIR> (customer-local, not pushed), variant A|B|C
- URLs: app=  profile=  api=  rpc=  webhook=   (or: internal only, port-forward)
- load balancer: type / size units / loadBalancerSourceRanges   (Variant A)
- Postgres: in-cluster (superuser password rotated at install) | other
- StorageClass (default):
- NetworkPolicy deny: proven | not   API egress: API_EGRESS_PATH=
- np-enforce-preflight FAIL lines (expected: check 3 gfs, llm-hooks):
- WRC CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED: true|false
- rollout check: all PASS | FAIL (list)
- billed DigitalOcean resources created this run (load balancers, volumes, snapshots):
- clusterlint findings reported:
- admin: claimed by the human via port-forward (password only in their password manager)
- day-2 reminders: re-run tokens + provision-gfs-runtime after any apply;
  after every DOKS upgrade re-read addresses, regenerate patches, apply, restart HCC
- not done / follow-ups:
```

Never put a password, token, key, or DSN into the handover, git, a ticket, or chat.
