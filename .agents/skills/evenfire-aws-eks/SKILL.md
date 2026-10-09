---
name: evenfire-aws-eks
description: >
  Deploy Evenfire into an existing Amazon EKS cluster using the public
  evenfire-ai/evenfire repo (kustomize on deploy/base + GHCR images at an
  official release tag). Use when the user asks to install or set up
  Evenfire/Clerum on AWS, EKS, or "our AWS cluster", to give their agent a
  production self-host guide, or to wire ALB, Cloudflare Tunnel, storage, or
  NetworkPolicies for that install. Do not use for minikube T0/T1/T2, creating
  a new EKS cluster, IPv6 clusters, or GKE/evenfire-infra.
---

# Evenfire on existing EKS

You are installing Evenfire (code name **clerum**) into a **pre-existing** IPv4
EKS cluster. You may add missing add-ons after asking. You do **not** create a
VPC, account, or cluster.

Full procedure: [docs/deploy/aws-eks-agent-guide.md](../../../docs/deploy/aws-eks-agent-guide.md).
It defines the validated release, the two checkouts, and the env file every
command sources. Load the references in this folder when the matching phase
needs them.

## When to use

- "Install Evenfire on our EKS / AWS cluster"
- "Give my agent the AWS deploy guide"
- First-time self-host on an already-running Kubernetes 1.30+ EKS cluster

Do **not** use for local minikube certification (`minikube-t0-t1-t2` skill),
greenfield cluster creation, or copying Evenfire's private GKE overlays.

## Customer prompt (paste this)

```text
Clone https://github.com/evenfire-ai/evenfire (default branch) and follow
.agents/skills/evenfire-aws-eks/SKILL.md to deploy Evenfire into my existing EKS
cluster. Install from a separate checkout of the release tag the guide
validates. Pin kubectl --context <CONTEXT> and AWS_PROFILE=<PROFILE>
AWS_REGION=<REGION> on every command. Do not create a cluster. Ask before any
paid AWS resource, Secret write, DNS change, or ingress exposure. Stop if the
NetworkPolicy deny probe fails. Never ask me for the admin password or LLM key;
I will enter them myself. Do not apply deploy/overlays/minikube* and do not
clone evenfire-infra.
```

## Hard limits

Always:

- Source `$HOME/.evenfire-eks/env.sh` at the start of every command and pass
  `--context "$CONTEXT"`. Shell state and aliases do not persist between agent
  commands.
- Install from `$REPO_DIR` at `$RELEASE_TAG` (the guide's validated release
  unless the human approves another). This skill ships no install tooling
  beyond the release's own `deploy/scripts`; write any helper yourself and keep
  it to the guide's criteria.
- Pull platform images only as `ghcr.io/evenfire-ai/<image>:$RELEASE_TAG`, and
  set every HCC spawned-image env var explicitly. The Phase 4 render gate must
  pass.
- Prove NetworkPolicy deny at packet level (guide 0.1) before installing (VPC
  CNI: network policy enabled **and** strict mode).
- Take CIDRs from the live cluster (guide 0.5); never copy them from another
  cluster.
- Fail closed. Print the stop reason. Do not invent CIDRs, image tags, or secrets.

Ask the human first:

- Creating EFS, RDS, ALB/NLB, or other billed AWS resources
- Changing the CNI or marking a default StorageClass
- Writing or rotating Kubernetes Secrets
- Exposing ingress, DNS, or TLS (only after the human claimed the admin account)
- Flipping WRC `CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED` to `true`
- Using a release other than the validated one

Never:

- Create or replace the EKS cluster / VPC / account
- Clone `evenfire-infra` or copy `deploy/overlays/gcp-*`
- Use `latest`, floating tags, `sha-<git>`, or private registry SHAs
- `kubectl apply -k deploy/overlays/minikube*`
- Set `CLERUM_DEV_MODE=true` or WRC `CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE=warn`
- Run `gen-jwt-keys.sh` when `control-api-secrets` exists
- See, handle, print, or pass on a command line the admin password, LLM keys,
  tunnel credentials, tokens, hashes, or DSNs
- Expose ingress before `/api/v1/admin/auth/setup` has been claimed by the human
- Call `scripts/minikube/sync-auth-key.sh` directly
- Impersonate `system:masters` for anything except the managed NetworkPolicies in guide 5.10
- Silently install CLIs; print the install command instead

## Phases

Follow the guide in order. Numbers match the guide's headings.

- **Phase 0** — tools, identity, discovery (read-only).
  - **[0.1]** NetworkPolicy enforcement: VPC CNI add-on and DaemonSet config
    (policy enabled, strict mode), then the packet-level deny check (owned and
    bare pod). Stop unless deny is proven.
  - **[0.2]** storage: a default RWO StorageClass.
- **Phase 0.5** — cluster coordinates: API ClusterIP and endpoints, kube-dns,
  NodeLocal DNS, load balancer subnets.
- **Phase 1** — add-ons only if missing (ask first).
- **Phase 2** — data plane: in-cluster Postgres; RDS is not covered.
- **Phase 3** — release checkout: [3.1] confirm the latest tag against the
  validated release, [3.2] clone the tag and verify the component pin.
- **Phase 4** — customer overlay meeting
  [references/overlay-requirements.md](references/overlay-requirements.md), then
  the render gate.
- **Phase 5** — install, in order:
  [5.1] namespaces (including `ingress`), [5.2] CRDs (Helm **and** YAML),
  [5.3] RBAC, [5.4] JWT keys once, [5.5] Postgres superuser password,
  [5.6] tokens, [5.7] DB migration, [5.8] runtime roles **and GFS credentials**,
  [5.9] re-render and gate, [5.10] apply (managed NetworkPolicies first when the
  caller is not `system:masters`), [5.11] tokens again,
  [5.12] `provision-gfs-runtime.sh`, [5.13] NetworkPolicy verify and preflight,
  [5.14] WRC enforcement confirmation, [5.15] rollout check (the Host stays
  pending until Phase 6).
- **Phase 6** — HUMAN claims the admin account through a port-forward, then
  enters the LLM key in Control UI.
- **Phase 7** — ingress: ALB/NLB patches already applied, or Tunnel credentials
  patched from a file.
- **Phase 8** — prove and hand over: [references/verify.md](references/verify.md).

Load [references/quirks.md](references/quirks.md) before writing the overlay.

## Scripts

Release scripts (`$REPO_DIR`). Source the env file first; guide steps in
brackets:

| Step | Command |
| --- | --- |
| Namespaces [5.1] | `kubectl --context "$CONTEXT" apply -f deploy/base/namespaces.yaml` and `-f deploy/base/ingress/namespace.yaml` |
| CRDs [5.2] | `helm upgrade --install --kube-context "$CONTEXT" clerum-crds ./charts/clerum-crds` then `kubectl --context "$CONTEXT" apply -f ./charts/clerum-crds/crds/` |
| RBAC [5.3] | `CONTEXT="$CONTEXT" bash deploy/scripts/bootstrap-rbac.sh` |
| JWT keys [5.4] | `CONTEXT="$CONTEXT" bash deploy/scripts/gen-jwt-keys.sh` only if `control-api-secrets` is absent |
| Postgres password [5.5] | guide 5.5 (patch file, never argv) |
| Tokens [5.6, 5.11] | `CONTEXT="$CONTEXT" bash deploy/scripts/apply-inter-service-tokens.sh` (first run also passes `CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET`; guide 5.6) |
| DB migration [5.7] | `CONTEXT="$CONTEXT" ALLOWED_CONTEXTS="$CONTEXT" bash deploy/scripts/run-control-api-db-migration.sh --overlay deploy/overlays/aws-eks` |
| Runtime roles [5.8] | `CONTEXT="$CONTEXT" ALLOWED_CONTEXTS="$CONTEXT" bash deploy/scripts/provision-control-api-runtime-roles.sh` |
| GFS credentials [5.8] | `GFS_REMOTE_RECONCILE_AUTHORIZED=true ALLOWED_CONTEXTS="$CONTEXT" CONTEXT="$CONTEXT" bash deploy/scripts/reconcile-gfs-deploy-credentials.sh` |
| Apply [5.10] | guide 5.10 block (managed NetworkPolicies first if needed, then the gated render) |
| GFS + auth sync + instances [5.12] | `ALLOWED_CONTEXTS="$CONTEXT" bash deploy/scripts/provision-gfs-runtime.sh --context "$CONTEXT" --overlay deploy/overlays/aws-eks` |
| NP verify [5.13] | `bash deploy/scripts/verify-networkpolicies.sh --overlay aws-eks --context "$CONTEXT"` |
| NP preflight [5.13] | `CONTEXT="$CONTEXT" OVERLAY=aws-eks bash deploy/scripts/np-enforce-preflight.sh` |

## Success

Hand the human the block in [references/verify.md](references/verify.md):
context, release, overlay variant, URLs (or internal only), enforcement and
probe result, AWS resources created, and confirmation that they claimed the
admin account themselves.
