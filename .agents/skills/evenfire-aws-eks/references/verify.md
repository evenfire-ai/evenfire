# Prove the install and hand over

Source the env file and pin `--context` on every command. Every check below
fails loudly; an empty result is never a pass.

## 1. Rollout (required)

```bash
. "$HOME/.evenfire-eks/env.sh"
cd "$REPO_DIR"
kubectl kustomize deploy/overlays/aws-eks > "$WORK/render.yaml"
CONTEXT="$CONTEXT" RENDER="$WORK/render.yaml" bash "$SKILL_SCRIPTS/verify-rollout.sh"
```

[`verify-rollout.sh`](../scripts/verify-rollout.sh) must end with
`verify-rollout: OK`. It checks, by exact name:

- Every Deployment in the render. At the validated release those are:
  - `control-plane`: `control-api`, `control-api-rpc-gateway`,
    `control-postgres`, `control-ui`, `codex-llm-proxy`,
    `host-context-controller`, `host-context-controller-api-gateway`,
    `nginx-workflow-approval-gateway`, `trace-maintenance-worker`,
    `workflow-recipes`
  - `channels`: `clerum-workflow-approval-request-reader`
  - `mcp-server`: `mcp-proxy`
  - `profiles`: `external-rest-api`, `profile-control-funnel`, `profile-ui`
  - `rpc-proxy`: `rpc-proxy`
  - `webhook-ingress`: `webhook-proxy`
  - `ingress`: `cloudflared` (Tunnel only)
- One HCC-spawned Deployment per Host (named after the Host), plus
  `gfs/gfsc-writer` and `gfs/gfsc-reader`.
- `GlobalFileSystem/gfs` `.status.phase` = `Ready`.
- No container in an Evenfire namespace waiting in `CrashLoopBackOff`,
  `ImagePullBackOff`, `ErrImagePull`, `CreateContainerConfigError`, or
  `CreateContainerError`, and none with more than 5 restarts. Pod phase alone
  hides crash loops.

## 2. Network isolation (required)

```bash
. "$HOME/.evenfire-eks/env.sh"
cd "$REPO_DIR"
bash deploy/scripts/verify-networkpolicies.sh --overlay aws-eks --context "$CONTEXT"
CONTEXT="$CONTEXT" OVERLAY=aws-eks bash deploy/scripts/np-enforce-preflight.sh
CONTEXT="$CONTEXT" bash "$SKILL_SCRIPTS/np-deny-probe.sh"
```

- `verify-networkpolicies.sh` renders the overlay, fails if the base placeholder
  `10.109.0.1/32` is still rendered, and checks every rendered policy exists
  live. It does not prove enforcement.
- The preflight must print no `FAIL`.
- The probe must exit 0 (owned and bare pod both denied).

Record whether WRC runs `CONFIRMED=true` (probe and preflight passed, human
agreed) or stays `false`, where recipes with external egress are refused.

## 3. JWT chain (required, no key material printed)

```bash
. "$HOME/.evenfire-eks/env.sh"
a="$(kubectl --context "$CONTEXT" -n rpc-proxy get secret rpc-proxy-secrets -o jsonpath='{.data.RPC_PROXY_JWT_PUBLIC_KEY}' | base64 -d | openssl dgst -sha256 | awk '{print $NF}')"
b="$(kubectl --context "$CONTEXT" -n mcp-host get configmap mcp-host-config -o jsonpath='{.data.CLERUM_AUTH_JWT_PUBLIC_KEY}' | openssl dgst -sha256 | awk '{print $NF}')"
c="$(kubectl --context "$CONTEXT" -n gfs get configmap gfs-config -o jsonpath='{.data.jwt-public-key}' | openssl dgst -sha256 | awk '{print $NF}')"
empty="$(printf '' | openssl dgst -sha256 | awk '{print $NF}')"
if [ "$a" != "$empty" ] && [ "$a" = "$b" ]; then echo 'PASS mcp-host-config key matches'; else echo 'FAIL mcp-host-config key'; fi
if [ "$a" != "$empty" ] && [ "$a" = "$c" ]; then echo 'PASS gfs-config key matches'; else echo 'FAIL gfs-config key'; fi
```

Only digests are printed (`sync-auth-key.sh` copies the value byte for byte).
On FAIL, re-run `provision-gfs-runtime.sh` (guide 5.12).

## 4. HTTP health

Internal (ask before opening local ports). Each port-forward goes in its own
terminal:

| Service | Port-forward | Check |
| --- | --- | --- |
| control-api | `-n control-plane service/control-api 18090:8090` | `curl -fsS http://127.0.0.1:18090/health` |
| external-rest-api | `-n profiles service/external-rest-api 18091:8091` | `curl -fsS http://127.0.0.1:18091/health` |
| rpc-proxy | `-n rpc-proxy service/rpc-proxy 18094:8094` | `curl -fsS http://127.0.0.1:18094/health` |
| control-ui | `-n control-plane service/control-ui 13000:3000` | `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:13000/` is `200` or a redirect |

With ingress live, check the five public HTTPS hostnames instead and confirm TLS
is valid.

## 5. Admin and LLM key (HUMAN)

- The human claimed the admin account through the port-forward (guide Phase 6)
  and can log in to Control UI. The agent never saw the password.
- The human entered the LLM key in Control UI → Secrets → LLM. A Host chat
  request succeeds from Control UI or the Desktop app.

## Handover block (print this)

```text
Evenfire EKS install
- kube context:
- AWS profile / region / cluster:
- release: RELEASE_TAG=      (validated release: )
- overlay: deploy/overlays/aws-eks in <REPO_DIR> (customer-local, not pushed), variant A|B
- URLs: app=  profile=  api=  rpc=  webhook=   (or: internal only, port-forward)
- Postgres: in-cluster (superuser password rotated at install) | other
- StorageClass (default): 
- CNI / enforcement mode / np-deny-probe result:
- WRC CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED: true|false
- verify-rollout.sh: OK | FAIL (list)
- AWS resources created this run:
- admin: claimed by the human via port-forward (password only in their password manager)
- day-2 reminders: re-run tokens + provision-gfs-runtime after any apply;
  re-detect API endpoints after every EKS version upgrade
- not done / follow-ups:
```

Never put a password, token, or key into the handover, git, a ticket, or chat.
