# Customer overlay contract (`deploy/overlays/aws-eks`)

This overlay is **local to the customer checkout**. Do not open a PR against
`evenfire-ai/evenfire` with it. Do not copy `deploy/overlays/minikube` or any
GKE overlay from a private infra repo.

## What it must include

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
  # Opt-in Cloudflare Tunnel stack. Omit this line if the customer uses their
  # own ingress (ALB / existing controller) instead.
  # - ../../base/ingress
  - configmaps/rpc-proxy-config.yaml   # required: not in base
  - configmaps/mcp-host-config.yaml    # required: not in base
  # - configmaps/cloudflared-config.yaml  # only if ingress is included

components:
  - ../../components/ghcr-images

# Multi-document YAML MUST use patchesStrategicMerge. Listing those files
# under patches: makes older kustomize fail with
# "unable to parse SM or JSON patch" and apply nothing.
patchesStrategicMerge:
  - configmaps/control-api-config.yaml
  - patches/dynamic-images.yaml
  - patches/resource-limits.yaml
  - patches/external-rest-api-cors.yaml   # if UIs are on real HTTPS origins

patches:
  - path: patches/storage-class.yaml
  - path: patches/workflow-output-storageclass.yaml
  - path: patches/k8s-api-ip.yaml
  - path: patches/k8s-api-ip-mcp-host.yaml
  - path: patches/k8s-api-ip-channels.yaml
  - path: patches/hcc-k8s-api-cidrs.yaml
```

`rpc-proxy-config` and `mcp-host-config` are referenced by base Deployments via
`configMapRef` but are **not** in `deploy/base`. Missing them →
`CreateContainerConfigError`.

## Images — last official public release only

Checkout the public repo **at the official release git tag**, not `main` / `dev`.
The last official release at the time this skill shipped is **`v0.8.0`**.

```bash
git clone --branch v0.8.0 https://github.com/evenfire-ai/evenfire.git
# or: git fetch --tags && git checkout v0.8.0
grep newTag deploy/components/ghcr-images/kustomization.yaml | sort -u
# expect a single value: v0.8.0
```

Every container image and every HCC/WRC spawned-pod env var must be:

`ghcr.io/evenfire-ai/<image>:v0.8.0`

Include the GHCR component so `clerum/*` Deployment images rewrite to that pin.
Base HCC/WRC env defaults are **not** `clerum/*` (leftover vendor-registry
paths) — patch them in `patches/dynamic-images.yaml` to the **same**
`ghcr.io/evenfire-ai/…:v0.8.0` tag.

Prefer `mcp-host-slim` for the Host runtime (`CONTEXT_MAPPER_HOST_IMAGE` and
`CLERUM_MCP_HOST_IMAGE`).

If a pull fails with `MANIFEST_UNKNOWN`, **stop**. Do not fall back to
`latest`, `main`, or `sha-*`. The official release tag and the git tag must
match; a mismatch is a release-publication problem, not an install workaround.

`MINIKUBE_IMAGE_TAG=latest` in `docs/deploy/minikube.md` is **minikube-only**
(it exists so local setup can run before the *next* tag is cut). It is not an
EKS install path.

Do not include `mock-mcp-server` / `mock-stdio-mcp-server` in a customer overlay.

Public GHCR needs no pull secret. Set:

```yaml
- name: CONTEXT_MAPPER_HOST_IMAGE_PULL_SECRET
  value: ""
- name: CONTEXT_MAPPER_WFC_IMAGE_PULL_SECRET
  value: ""
```

If the customer mirrors to private ECR, ask them for the pull-secret name and
allowlist prefixes.

Allowlists to patch (comma-separated prefixes):

- `CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES` (HCC)
- `CONTROL_API_ALLOWED_IMAGE_PREFIXES` (control-api ConfigMap)
- `WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES` (WRC)

Include `ghcr.io/evenfire-ai/` and, if they use the registry, `registry.evenfire.ai/`.

## Dynamic images (must patch)

HCC and WRC spawn child pods from env vars. At minimum set:

| Deployment | Env | Typical GHCR image |
| --- | --- | --- |
| host-context-controller | `CONTEXT_MAPPER_HOST_IMAGE` | `mcp-host-slim` |
| host-context-controller | `CONTEXT_MAPPER_EGRESS_PROXY_IMAGE` | `nginx-egress-proxy` |
| host-context-controller | `CONTEXT_MAPPER_GFSC_IMAGE` | `gfs-controller` |
| host-context-controller | `STDIO_BRIDGE_IMAGE` and `CONTEXT_MAPPER_STDIO_BRIDGE_IMAGE` | `stdio-bridge` |
| host-context-controller | `CONTEXT_MAPPER_DESKTOP_IMAGE` | `mcp-host-desktop` if published; else omit / ask |
| host-context-controller | `CONTEXT_MAPPER_CHANNEL_READER_IMAGE` | `channel-reader` |
| host-context-controller | `CONTEXT_MAPPER_WFC_IMAGE` | `workspace-files-controller` |
| host-context-controller | `CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS` | customer RWO class (`gp2`/`gp3`) |
| control-api | `CONTROL_API_REMOTE_MCP_EGRESS_PROXY_IMAGE` | `nginx-egress-proxy` |
| workflow-recipes | `CLERUM_COORDINATOR_IMAGE` | `workflow-coordinator` |
| workflow-recipes | `CLERUM_MCP_HOST_IMAGE` | `mcp-host-slim` |
| workflow-recipes | `CLERUM_SNIPPET_RUNNER_IMAGE` | `workflow-snippet-runner` |
| workflow-recipes | `WRC_WEBHOOK_GATEWAY_IMAGE` | `webhook-gateway` |

Confirm every name against `deploy/components/ghcr-images/kustomization.yaml`.
If `mcp-host-desktop` is absent from that list, do not invent it.

## Kubernetes API CIDRs

Detect (never hardcode):

```bash
kubectl --context "$CONTEXT" get svc kubernetes -n default \
  -o jsonpath='{.spec.clusterIP}{"\n"}'
kubectl --context "$CONTEXT" get endpoints kubernetes -n default \
  -o jsonpath='{.subsets[*].addresses[*].ip}{"\n"}'
```

On Kubernetes 1.33+ `Endpoints` may be empty — then read EndpointSlices for
service `kubernetes` in `default`.

Write **ClusterIP and every endpoint** as `/32` (IPv4) into:

- `patches/k8s-api-ip.yaml` → `allow-k8s-api-egress-control-plane`
- `patches/k8s-api-ip-mcp-host.yaml` → `allow-k8s-api-egress-mcp-host`
- `patches/k8s-api-ip-channels.yaml` → the channels namespace equivalent
- `CONTEXT_MAPPER_K8S_API_CIDRS` on HCC (comma-separated, same list)

HCC **crashes on startup** if any CIDR is malformed or broader than IPv4 `/24`
or IPv6 `/120`. Use `/32`s.

Base ships placeholder `10.109.0.1/32`. `verify-networkpolicies.sh` **fails**
if that CIDR is still in the render (`FORBID_CIDR` default). Your patches must
replace it.

Some CNIs (notably Calico on GKE) enforce egress against the **post-DNAT
apiserver IP**, not the Service ClusterIP. ClusterIP-only rules drop HCC/WRC
and they crash-loop. Always include both.

## DNS

Base DNS policies allow port 53 to pods in `kube-system` via
`namespaceSelector`. That is enough for stock EKS CoreDNS **if** the CNI
honors namespace selectors.

If NodeLocal DNSCache is installed, or a packet-level deny probe shows DNS
fails after enforcement, add an ipBlock for the kube-dns ClusterIP `/32` (and
the node-local cache IP if used). HCC's `CONTEXT_MAPPER_NODELOCAL_DNS_CIDR`
must be **exactly one IPv4 /32** or empty — not a list.

```bash
kubectl --context "$CONTEXT" -n kube-system get svc kube-dns \
  -o jsonpath='{.spec.clusterIP}{"\n"}'
kubectl --context "$CONTEXT" -n kube-system get ds node-local-dns 2>/dev/null || true
```

## Storage

| PVC / consumer | Access | EKS class |
| --- | --- | --- |
| `control-postgres-data` (`control-plane`) | RWO | `gp2` or `gp3` (ask which exists) |
| `clerum-workflow-output` (`sandbox-recipes`) | RWO only if **single node**; **RWX** if ≥2 nodes | EFS CSI StorageClass for RWX |
| HCC workspace PVCs | RWO | same as Postgres class via `CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS` |

Single-node RWO for workflow output is a known GKE compromise (many pods on one
node can share RWO). Multi-node EKS **must** get EFS (or equivalent RWX). Ask
before creating an EFS file system.

## Public URLs and CORS

If users reach the platform over HTTPS, patch these together (they must match):

| Surface | Service | Typical hostname |
| --- | --- | --- |
| Control UI | `control-ui.control-plane.svc:3000` | `app.<domain>` |
| Profile UI | `profile-ui.profiles.svc:3001` | `profile.<domain>` |
| External REST / OAuth callback | `external-rest-api.profiles.svc:8091` | `api.<domain>` |
| Desktop RPC (SSE) | `rpc-proxy.rpc-proxy.svc:8094` | `rpc.<domain>` |
| Webhooks | `webhook-proxy.webhook-ingress.svc:8095` | `webhook.<domain>` |

Set `CONTROL_API_*_BASE_URL`, `EXTERNAL_REST_API_CORS_ORIGIN`,
`EXTERNAL_REST_API_PUBLIC_BASE_URL`, `EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL`,
`RPC_PROXY_CORS_ORIGIN`, `RPC_PROXY_OAUTH_CALLBACK_BASE_URL`,
`WEBHOOK_PUBLIC_BASE_URL`. For SSE on `rpc`, do not disable chunked encoding.

Hosted member invitations require **real, publicly resolvable** Profile and
Control UI URLs — see `docs/how-to/member-invitations-self-hosted.md`.

## NetworkPolicy enforcement mode

Until a packet-level deny is proven on **this** cluster, set on WRC:

```yaml
- name: CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE
  value: warn
- name: CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED
  value: "false"
```

After `deploy/scripts/np-enforce-preflight.sh` is clean **and** a deny probe
works, ask the human before flipping to `required` / `true`.

Do not copy gcp-dev-only HCC resync timers or GFS Upload v2 activation.

## What not to put in the overlay

- `fake-telegram/`
- minikube `127.0.0.1` URLs
- `patches/service-tokens.yaml` with `replace-with-*` placeholders (wipes live tokens on apply)
- Registry Postgres/MinIO secrets (registry is a separate product)
- Evenfire's Artifact Registry hostnames or tunnel UUIDs
