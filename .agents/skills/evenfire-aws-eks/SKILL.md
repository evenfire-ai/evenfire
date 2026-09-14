---
name: evenfire-aws-eks
description: >
  Deploy Evenfire into an existing Amazon EKS cluster using the public
  evenfire-ai/evenfire repo (kustomize on deploy/base + GHCR images). Use when
  the user asks to install or set up Evenfire/Clerum on AWS, EKS, or "our AWS
  cluster", to give their agent a production self-host guide, or to wire EFS,
  RDS, ALB, Cloudflare Tunnel, or NetworkPolicies for that install. Do not use
  for minikube T0/T1/T2, creating a new EKS cluster, or GKE/evenfire-infra.
---

# Evenfire on existing EKS

You are installing Evenfire (code name **clerum**) into a **pre-existing** EKS
cluster. The customer already has Kubernetes. You may add missing add-ons
(EFS CSI, a NetworkPolicy CNI, optional ALB controller, optional RDS) after
asking. You do **not** create a VPC, account, or cluster.

Full procedure: [docs/deploy/aws-eks-agent-guide.md](../../../docs/deploy/aws-eks-agent-guide.md).
Load references in this folder only when the matching phase needs them.

## When to use

- "Install Evenfire on our EKS / AWS cluster"
- "Give my agent the AWS deploy guide"
- First-time self-host on an already-running Kubernetes 1.30+ EKS cluster

Do **not** use for local minikube certification (`minikube-t0-t1-t2` skill),
greenfield cluster creation, or copying Evenfire's private GKE overlays.

## Customer prompt (paste this)

```text
Using the evenfire-aws-eks skill, deploy Evenfire into my existing EKS cluster.
Pin kubectl --context <CONTEXT> and AWS_PROFILE=<PROFILE> AWS_REGION=<REGION>
on every command. Do not create a cluster. Ask before any paid AWS resource
or Secret write. Stop if NetworkPolicies are not enforced. Do not apply
deploy/overlays/minikube* and do not clone evenfire-infra.
```

## Hard limits

Always:

- Pin `kubectl --context <CONTEXT>` and `AWS_PROFILE` / `AWS_REGION` on every command. Current-context is not load-bearing.
- Clone **evenfire-ai/evenfire at the last official release git tag** (currently `v0.8.0`). Confirm `deploy/components/ghcr-images/kustomization.yaml` `newTag` equals that tag. Compose a **customer-local** overlay from `deploy/base` + that GHCR component.
- Pull **only** `ghcr.io/evenfire-ai/<image>:<official-release>` (today `v0.8.0`). Same tag on every image, including HCC/WRC dynamic env vars (`mcp-host-slim`, coordinator, gfsc, …).
- Detect Kubernetes API ClusterIP **and** endpoint IPs before writing NetworkPolicies.
- Fail closed. Print the stop reason. Do not invent CIDRs, image tags, or secrets.

Ask the human first:

- Creating EFS, RDS, ALB/NLB, or other billed AWS resources
- Writing or rotating Kubernetes Secrets, JWT keys (`FORCE_REGEN`), or LLM keys
- Changing DNS / TLS / public hostnames

Never:

- Create or replace the EKS cluster / VPC / account
- Clone `evenfire-infra` or copy `deploy/overlays/gcp-*` (private; wrong CIDRs, credentials, and **private registry SHAs**)
- Use `latest`, floating tags, `sha-<git>`, or `*.pkg.dev` / ECR mirrors unless the human named a private mirror **and** kept the official release tag
- `kubectl apply -k deploy/overlays/minikube*` (hostPath, fake Telegram, localhost URLs)
- Set `CLERUM_DEV_MODE=true`
- Commit tokens, LLM keys, tunnel credentials, or admin passwords
- Print Secret values
- Silently install CLIs; print the install command (same idea as `make doctor`)

## Phases

Follow [aws-eks-agent-guide.md](../../../docs/deploy/aws-eks-agent-guide.md) in order. Summary:

0. **Collect inputs** — context, profile, region, cluster name, DNS names or "internal only", ingress choice, Postgres choice, LLM provider.
1. **Discover, do not mutate** — identity, kube version ≥ 1.30, node capacity, StorageClasses, CNI + NetworkPolicy enforcement, ingress class, admission webhooks. Stop if context is wrong or NetworkPolicies are not enforced.
2. **Detect cluster coordinates** — API ClusterIP + endpoints, kube-dns IP, NodeLocal DNSCache if present, node count. Write them into the overlay; never paste another cloud's CIDRs. See [references/overlay-contract.md](references/overlay-contract.md).
3. **Add-ons only if missing** — NetworkPolicy CNI, EFS CSI + RWX if multi-node, optional AWS Load Balancer Controller. Ask first if it costs money.
4. **Customer overlay** — create `deploy/overlays/aws-eks/` in the **release-tag checkout** (do not PR it to evenfire-ai/evenfire). See overlay-contract.
5. **Install** — namespaces → CRDs (Helm **and** re-apply YAML) → RBAC → JWT keys → secrets via `kubectl patch` → inter-service tokens → DB migration → kustomize apply → JWT public-key sync → GFS provision → NetworkPolicy verify → instances → restart ConfigMap consumers → real admin bcrypt → ingress.
6. **Prove and hand over** — [references/verify.md](references/verify.md).

Load [references/quirks.md](references/quirks.md) before writing the overlay. Those are the failures that already took a production cluster down or wiped secrets.

## Scripts to use (public repo)

Pin `CONTEXT=<kube-context>` on all of these:

| Step | Command |
| --- | --- |
| Namespaces | `kubectl --context "$CONTEXT" apply -f deploy/base/namespaces.yaml` |
| CRDs | `helm upgrade --install --kube-context "$CONTEXT" clerum-crds ./charts/clerum-crds` then `kubectl --context "$CONTEXT" apply -f ./charts/clerum-crds/crds/` |
| RBAC | `CONTEXT="$CONTEXT" bash deploy/scripts/bootstrap-rbac.sh` |
| JWT keys | `CONTEXT="$CONTEXT" bash deploy/scripts/gen-jwt-keys.sh` (skip if Secrets already exist) |
| Tokens | `CONTEXT="$CONTEXT" bash deploy/scripts/apply-inter-service-tokens.sh` |
| DB migration | `CONTEXT="$CONTEXT" ALLOWED_CONTEXTS="$CONTEXT" bash deploy/scripts/run-control-api-db-migration.sh --overlay deploy/overlays/aws-eks` |
| Apply | `kubectl kustomize deploy/overlays/aws-eks \| kubectl --context "$CONTEXT" apply -f -` |
| JWT sync | `bash scripts/minikube/sync-auth-key.sh --context "$CONTEXT"` |
| GFS | `bash deploy/scripts/provision-gfs-runtime.sh --context "$CONTEXT" --overlay deploy/overlays/aws-eks --allow-prod` (prod-like clusters need `--allow-prod` **and** human confirmation) |
| NP verify | `bash deploy/scripts/verify-networkpolicies.sh --overlay aws-eks --context "$CONTEXT"` |

`verify-networkpolicies.sh` resolves `deploy/overlays/<name>`, so the overlay directory **must** be `deploy/overlays/aws-eks`.

## Success

Hand the human: kube context, image tag, public URLs (or "ClusterIP only"), namespaces Ready, what AWS resources you created, and the admin username with the password stored only in their password manager (not in git, not in chat if they prefer a secret store).
