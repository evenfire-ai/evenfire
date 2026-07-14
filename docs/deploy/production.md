# Production deployment (notes)

This repository ships **Kubernetes manifests**, operators, and a Helm chart for
CRDs. A single turnkey “one cloud vendor” guide is not published in this OSS
tree yet; use this page as the production checklist and link into in-repo
assets.

## What “production” means here

- All platform services deployed to a real cluster (not a single dev-mode `mcp-host`)
- JWT auth chain on the external edges (desktop → rpc-proxy, service → control-api);
  `mcp-host` runtime routes still use edge trust headers, restricted by NetworkPolicy
- Default-deny NetworkPolicies enforced (Calico or equivalent CNI with policy)
- Secrets and LLM keys in cluster Secrets / your secret manager
- Non-root, capability-dropped workloads; coordinator images digest-pinned and
  the connector-image allowlist switched from audit to enforce

## Building blocks in this repo

| Asset                      | Path                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| CRDs (Helm)                | [charts/clerum-crds](../../charts/clerum-crds/README.md)           |
| Base manifests             | [deploy/base](../../deploy/base)                                   |
| Overlays                   | [deploy/overlays](../../deploy/overlays)                           |
| Bootstrap scripts          | [scripts/](../../scripts/), [deploy/scripts](../../deploy/scripts) |
| Local full-stack reference | [minikube.md](minikube.md)                                         |
| Observability starter      | [monitoring/](../../monitoring/README.md)                          |

Install CRDs:

```bash
helm install clerum-crds ./charts/clerum-crds
# After chart upgrades, re-apply CRD YAML (Helm 3 does not upgrade crds/ on upgrade):
kubectl apply -f ./charts/clerum-crds/crds/
```

## Recommended rollout order

1. **Cluster prerequisites** — CNI with NetworkPolicy, storage classes as needed,
   registry pull credentials.
2. **CRDs** — install/apply `clerum-crds`.
3. **Namespaces + deny-all baseline** — from `deploy/base` overlays.
4. **Signing / JWT keys** — bootstrap scripts under `scripts/` and deploy docs.
5. **Control plane services** — `host-context-controller`, `control-api`, proxies.
6. **Agent runtime** — `mcp-host`, `channel-reader`, bridges.
7. **UIs** — `control-ui`, `profile-ui` (and desktop distribution separately).
8. **First Host + Context + channel** — smallest viable declarative config.
9. **Connectors** — McpServers on an allowlisted Context.
10. **Observability** — metrics + log stack; alert on approval backlog and 5xx.

Use [minikube.md](minikube.md) as the **order-of-operations reference** even when
the target is not minikube: the dependency graph is the same.

## Security non-negotiables

- Do not run with `CLERUM_DEV_MODE=true`, and never expose `mcp-host`'s runtime
  port beyond the NetworkPolicy-allowed edge services — the edge trust headers
  it accepts are forgeable by anyone who can reach the port.
- Keep default-deny NetworkPolicies; only open (context, server) pairs you intend.
- Treat approval policy as a control, not a UX preference.
- Report vulnerabilities per [SECURITY.md](../../SECURITY.md).

## License

evenfire is open source under **MPL-2.0**: self-hosting, modification, and
commercial use are permitted; file-level copyleft applies when you distribute
modified MPL-licensed files. See [LICENSE](../../LICENSE).

## Related

- [WorkflowRecipes operations](workflow-recipes-guide.md)
- [Architecture / topology](../architecture/platform-topology.md)
- [FAQ](../faq.md)
