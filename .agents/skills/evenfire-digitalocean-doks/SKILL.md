---
name: evenfire-digitalocean-doks
description: >
  Deploy Evenfire into an existing DigitalOcean Kubernetes (DOKS) cluster using
  the public evenfire-ai/evenfire repo (kustomize on deploy/base + GHCR images at
  an official release tag). Use when the user asks to install or set up
  Evenfire/Clerum on DigitalOcean, DOKS, or "our DO cluster", to give their agent
  a DigitalOcean self-host guide, or to wire ingress, Cloudflare Tunnel, storage,
  or NetworkPolicies for that install. Do not use for minikube T0/T1/T2, creating
  a new DOKS cluster, EKS, or GKE/evenfire-infra.
---

# Evenfire on existing DOKS

You are installing Evenfire (code name **clerum**) into a **pre-existing** DOKS
cluster. You may add a missing ingress controller after asking. You do **not**
create a DigitalOcean team, VPC, or cluster.

Full procedure: [docs/deploy/digitalocean-doks-agent-guide.md](../../../docs/deploy/digitalocean-doks-agent-guide.md).
It defines the validated release, the two checkouts, and the env file every
command sources. Load the references in this folder when the matching phase
needs them.

## When to use

- "Install Evenfire on our DigitalOcean / DOKS cluster"
- "Give my agent the DigitalOcean deploy guide"
- First-time self-host on an already-running DOKS cluster

Do **not** use for local minikube certification (`minikube-t0-t1-t2` skill),
greenfield cluster creation, Amazon EKS, or copying Evenfire's private GKE
overlays.

## Customer prompt (paste this)

```text
Clone https://github.com/evenfire-ai/evenfire (default branch) and follow
.agents/skills/evenfire-digitalocean-doks/SKILL.md to deploy Evenfire into my
existing DOKS cluster. Install from a separate checkout of the release tag the
guide validates. Pin doctl --context <DOCTL_CONTEXT> and
kubectl --context <CONTEXT> on every command, and never run doctl auth switch.
Do not create a cluster. Ask before any billed DigitalOcean resource, Secret
write, DNS change, ingress exposure, or running the network probes. Stop if a
probe fails. Never ask me for the admin password or LLM key; I will enter them
myself. Do not apply deploy/overlays/minikube* and do not clone evenfire-infra.
```

## Hard limits

Always:

- Source `$HOME/.evenfire-doks/env.sh` at the start of every command, pass
  `--context "$DOCTL_CONTEXT"` to `doctl` and `--context "$CONTEXT"` to
  `kubectl`. Shell state and aliases do not persist between agent commands.
- Install from `$REPO_DIR` at `$RELEASE_TAG` (the guide's validated release
  unless the human approves another). Run helpers from `$SKILL_SCRIPTS` in the
  default-branch checkout.
- Pull platform images only as `ghcr.io/evenfire-ai/<image>:$RELEASE_TAG`, and
  set every HCC spawned-image env var explicitly. `image-gate.rb` must pass.
- Prove NetworkPolicy deny with `np-deny-probe.sh` and Kubernetes API egress with
  `api-egress-probe.sh` before installing.
- Take cluster values from `doks-discover.sh` and generate network files with
  `write-network-patches.sh`; never hand-write addresses.
- Fail closed. Print the stop reason. Do not invent addresses, image tags, or
  secrets.

Ask the human first:

- Load balancers, volumes, snapshots, or any other billed DigitalOcean resource
- Installing an ingress controller
- Running the probes (each creates and deletes a temporary namespace)
- Writing or rotating Kubernetes Secrets
- Exposing ingress, DNS, or TLS (only after the human claimed the admin account)
- Flipping WRC `CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED` to `true`
- Using a release other than the validated one

Never:

- Create or replace the DOKS cluster, VPC, or team; run `doctl auth switch`
- Edit Cilium, CoreDNS, Gateway API CRDs, or objects labelled
  `doks.digitalocean.com/managed`
- Install ingress-nginx (no security fixes upstream since March 2026)
- Clone `evenfire-infra` or copy `deploy/overlays/gcp-*`
- Use `latest`, floating tags, `sha-<git>`, or private registry SHAs
- `kubectl apply -k deploy/overlays/minikube*`
- Set `CLERUM_DEV_MODE=true` or WRC `CLERUM_NETWORK_POLICY_ENFORCEMENT_MODE=warn`
- Run `gen-jwt-keys.sh` when `control-api-secrets` exists
- See, handle, print, or pass on a command line the admin password, LLM keys,
  tunnel credentials, tokens, hashes, or DSNs
- Expose ingress before `/api/v1/admin/auth/setup` has been claimed by the human
- Call `scripts/minikube/sync-auth-key.sh` directly
- Convert Evenfire workloads to StatefulSets to satisfy clusterlint; report instead
- Impersonate `system:masters` for anything except the managed NetworkPolicies in guide 5.10
- Silently install CLIs; print the install command instead

## Phases

Follow the guide in order. Numbers match the guide's headings.

- **Phase 0** — tools, `doctl` identity, kubeconfig context (saved with
  `--set-current-context=false`), [`scripts/doks-discover.sh`](scripts/doks-discover.sh).
  - **[0.1]** [`scripts/np-deny-probe.sh`](scripts/np-deny-probe.sh) and
    [`scripts/api-egress-probe.sh`](scripts/api-egress-probe.sh); both must exit 0.
    Record `API_EGRESS_PATH`.
  - **[0.2]** storage: the single default StorageClass from discovery.
- **Phase 0.5** — cluster coordinates from discovery output.
- **Phase 1** — add-ons only if missing: an in-cluster ingress controller for
  Variant A (ask first; billed load balancer).
- **Phase 2** — data plane: in-cluster Postgres; DigitalOcean Managed PostgreSQL
  is not covered.
- **Phase 3** — release checkout: [3.1] confirm the latest tag against the
  validated release, [3.2] clone the tag and verify the component pin.
- **Phase 4** — customer overlay per
  [references/overlay-contract.md](references/overlay-contract.md), then
  [`scripts/write-network-patches.sh`](scripts/write-network-patches.sh), then the
  render gate.
- **Phase 5** — install, in order:
  [5.1] namespaces (including `ingress`), [5.2] CRDs (Helm **and** YAML),
  [5.3] RBAC, [5.4] JWT keys once, [5.5] Postgres superuser password,
  [5.6] tokens, [5.7] DB migration, [5.8] runtime roles **and GFS credentials**, [5.9] re-render and
  gate, [5.10] apply, [5.11] tokens again, [5.12] `provision-gfs-runtime.sh`,
  [5.13] NetworkPolicy verify and preflight (check 3 FAILs for `gfs` and
  `llm-hooks` are expected), [5.14] WRC enforcement confirmation,
  [5.15] `verify-rollout.sh`.
- **Phase 6** — HUMAN claims the admin account through a port-forward, then
  enters the LLM key in Control UI.
- **Phase 7** — ingress: controller patches already applied (Variant A),
  Tunnel credentials patched from a file (Variant B), or nothing to expose
  (Variant C, internal only).
- **Phase 8** — prove and hand over: [references/verify.md](references/verify.md).

Load [references/quirks.md](references/quirks.md) before writing the overlay.

## Scripts

Release checkout (`$REPO_DIR`). Source the env file first; guide steps in
brackets:

| Step | Command |
| --- | --- |
| Namespaces [5.1] | `kubectl --context "$CONTEXT" apply -f deploy/base/namespaces.yaml` and `-f deploy/base/ingress/namespace.yaml` |
| CRDs [5.2] | `helm upgrade --install --kube-context "$CONTEXT" clerum-crds ./charts/clerum-crds` then `kubectl --context "$CONTEXT" apply -f ./charts/clerum-crds/crds/` |
| RBAC [5.3] | `CONTEXT="$CONTEXT" bash deploy/scripts/bootstrap-rbac.sh` |
| JWT keys [5.4] | `CONTEXT="$CONTEXT" bash deploy/scripts/gen-jwt-keys.sh` only if `control-api-secrets` is absent |
| Postgres password [5.5] | guide 5.5 (patch file, never argv) |
| Tokens [5.6, 5.11] | `CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET=… CONTEXT="$CONTEXT" bash deploy/scripts/apply-inter-service-tokens.sh` |
| DB migration [5.7] | `CONTEXT="$CONTEXT" ALLOWED_CONTEXTS="$CONTEXT" bash deploy/scripts/run-control-api-db-migration.sh --overlay deploy/overlays/digitalocean-doks` |
| Runtime roles [5.8] | `CONTEXT="$CONTEXT" ALLOWED_CONTEXTS="$CONTEXT" bash deploy/scripts/provision-control-api-runtime-roles.sh` |
| GFS credentials [5.8] | `GFS_REMOTE_RECONCILE_AUTHORIZED=true ALLOWED_CONTEXTS="$CONTEXT" CONTEXT="$CONTEXT" bash deploy/scripts/reconcile-gfs-deploy-credentials.sh` |
| Apply [5.10] | managed NetworkPolicies via `managed-netpols.rb` with `--as-group=system:masters`, then `kubectl --context "$CONTEXT" apply -f "$WORK/render.yaml"` (guide 5.10) |
| GFS + auth sync + instances [5.12] | `ALLOWED_CONTEXTS="$CONTEXT" bash deploy/scripts/provision-gfs-runtime.sh --context "$CONTEXT" --overlay deploy/overlays/digitalocean-doks` |
| NP verify [5.13] | `bash deploy/scripts/verify-networkpolicies.sh --overlay digitalocean-doks --context "$CONTEXT"` |
| NP preflight [5.13] | `CONTEXT="$CONTEXT" OVERLAY=digitalocean-doks bash deploy/scripts/np-enforce-preflight.sh` |

Skill helpers (`$SKILL_SCRIPTS`):

| Helper | Purpose |
| --- | --- |
| `doks-discover.sh` | read-only discovery: identity, cluster facts, API and DNS addresses, StorageClass, Cilium settings, default load balancer type |
| `np-deny-probe.sh` | packet-level egress deny proof (owned and bare pod) |
| `api-egress-probe.sh` | API-server egress under deny-all: ipBlock vs CiliumNetworkPolicy |
| `write-network-patches.sh` | API / DNS / HCC patches, Cilium API egress policies, ingress-controller patches |
| `image-gate.rb` | render gate: official GHCR tag, known third-party pins, no unset HCC image env vars |
| `managed-netpols.rb` | selects the NetworkPolicies only `system:masters` may create, for the one impersonated apply in 5.10 |
| `verify-rollout.sh` | fail-loud rollout proof by exact Deployment name plus container states |

## Success

Hand the human the block in [references/verify.md](references/verify.md):
`doctl` context and team, cluster facts, release, overlay variant, URLs (or
internal only), probe results and `API_EGRESS_PATH`, billed resources created,
clusterlint findings, and confirmation that they claimed the admin account
themselves.
