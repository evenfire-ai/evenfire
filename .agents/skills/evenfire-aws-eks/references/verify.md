# Prove the install and hand over

Pin `--context` on every command. Do not declare success from a single pod
screenshot.

## Required Deployments Ready

Wait until Ready replicas match spec in at least:

| Namespace | Deployments (names may grow; list with `kubectl get deploy`) |
| --- | --- |
| `control-plane` | `control-api`, `control-ui`, `host-context-controller`, `workflow-recipes`, `control-postgres` (if in-cluster) |
| `profiles` | `external-rest-api`, `profile-ui` |
| `rpc-proxy` | `rpc-proxy` |
| `mcp-host` | HCC-managed Host(s), often `chatllm` after instances |
| `channels` | `workflow-approval-request-reader`; per-Host `channel-reader-*` after a Host exists |
| `gfs` | GFS controller workloads after `provision-gfs-runtime.sh` |
| `webhook-ingress` | `webhook-proxy` |
| `ingress` | `cloudflared` only if that stack was opted in |

```bash
kubectl --context "$CONTEXT" get deploy -A \
  --selector app.kubernetes.io/part-of=clerum
kubectl --context "$CONTEXT" get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
```

No `CreateContainerConfigError`, `ImagePullBackOff`, or CrashLoop on platform
Deployments.

## NetworkPolicies exist

```bash
bash deploy/scripts/verify-networkpolicies.sh --overlay aws-eks --context "$CONTEXT"
```

Confirm the render does **not** still contain `10.109.0.1/32`.

Optional packet-level check (ask first): from a deny-all runtime pod, a connect
to an unlisted destination must fail. Until that is proven, keep
`CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED=false`.

## JWT chain sanity

- `rpc-proxy-secrets` has `RPC_PROXY_JWT_PUBLIC_KEY`
- `mcp-host-config` `CLERUM_AUTH_JWT_PUBLIC_KEY` matches that public key
  (after `sync-auth-key.sh`)
- `CLERUM_ENABLE_AUTH` / issuer `control-api` as in the overlay ConfigMaps

Do not print private keys.

## HTTP health (pick what the overlay exposed)

Internal (port-forward, ask before opening ports on the customer's laptop):

| Service | Port | Check |
| --- | --- | --- |
| control-api | 8090 | HTTP health/ready as documented in `control-api` README |
| external-rest-api | 8091 | responds |
| rpc-proxy | 8094 | responds |
| control-ui | 3000 | HTML 200 |

If Cloudflare Tunnel / ALB is live, hit the five public hostnames over HTTPS
instead of port-forward.

## First Host

After `instances/` are applied, `kubectl --context "$CONTEXT" get host,context -A`
shows the bootstrap Host (often `chatllm`) Ready enough to accept a Desktop
session. HCC must own the Host before promising chat works.

## Admin login

Log in to Control UI as `admin` with the password you set (not the placeholder
hash). If login fails with a bcrypt error, the placeholder is still in the DB —
fix that before handover.

## Handover block (print this)

```text
Evenfire EKS install
- kube context:
- AWS profile / region / cluster:
- image tag (must be ghcr.io/evenfire-ai/*:v0.8.0):
- overlay path: deploy/overlays/aws-eks (customer-local)
- URLs: app=  profile=  api=  rpc=  webhook=  (or ClusterIP-only)
- Postgres: in-cluster | RDS (name)
- RWX StorageClass:
- NetworkPolicy CNI / enforcement:
- AWS resources created this run:
- admin user: admin  (password in the human's password manager)
- not done / follow-ups:
```

Do not put the password in git or in a ticket. If the chat must not retain it,
tell the human it was printed once above and they should store it now.
