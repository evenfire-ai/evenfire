# Clerum Documentation

Clerum is a Kubernetes-native platform for LLM orchestration with multi-channel communication (Telegram, Email, Slack) and MCP (Model Context Protocol) integration. All configuration is driven by Kubernetes Custom Resources (CRDs) under the `clerum.io` API group.

This directory holds the project's long-form documentation. Start at the root [`README.md`](../README.md) for the monorepo layout and service list, and at [`CLAUDE.md`](../CLAUDE.md) for developer commands (build, test, minikube, GCP).

---

## Architecture & design

- [`architecture/overview.md`](architecture/overview.md) — full architecture reference (services, CRDs, message lifecycle, NetworkPolicy model, deployment sequence).
- [`architecture/platform-topology.md`](architecture/platform-topology.md) — 7-namespace topology, HCC/WRC controller split, deny-all security baseline.
- [`architecture/non-mcp-services.md`](architecture/non-mcp-services.md) — namespace splitting rules and L0–L3 NetworkPolicy layers for non-MCP workloads.
- [`architecture/diagrams/`](architecture/diagrams/) — Excalidraw source files for architecture diagrams (agent state machine, CRD relationships, high-level architecture, message lifecycle, NetworkPolicy, operator reconciliation).

## Deployment & operations

- [`deploy/minikube.md`](deploy/minikube.md) — full local-cluster deployment guide (setup, JWT auth chain, WorkflowRecipes config).
- [`deploy/gcp.md`](deploy/gcp.md) — production GCP (GKE) deployment guide.
- [`deploy/workflow-internal-dependency-networkpolicy-runbook.md`](deploy/workflow-internal-dependency-networkpolicy-runbook.md) — post-rollout validation and hotfix cleanup for WRC-owned intra-recipe NetworkPolicies.
- [`deploy/workflow-recipes-guide.md`](deploy/workflow-recipes-guide.md) — configuration, operations, and debugging for WorkflowRecipes (CRD, Control UI, RBAC, REST API).
- [`deploy/workflow-bugs-2026-03-24.md`](deploy/workflow-bugs-2026-03-24.md) — WorkflowRecipes bug index (10 bugs with root causes and commits).

## Security

Security-sensitive runtime guidance is tracked in the root [`CLAUDE.md`](../CLAUDE.md), [`AGENTS.md`](../AGENTS.md), deploy guides, and Kubernetes manifests. Ignored local security notes are not part of the repo contract.

## CRD Reference

- [`crds/README.md`](crds/README.md) — CRD reference index (all 6 `clerum.io/v1alpha1` CRDs).
- [`crds/host.md`](crds/host.md) — Host CRD (LLM provider config, context + secret refs).
- [`crds/context.md`](crds/context.md) — Context CRD (MCP server allowlist).
- [`crds/mcpserver.md`](crds/mcpserver.md) — McpServer CRD (deployment spec, transport, auth, env).
- [`crds/workflowrecipe.md`](crds/workflowrecipe.md) — WorkflowRecipe CRD (multi-workload composition).
- [`crds/communicationchannel.md`](crds/communicationchannel.md) — CommunicationChannel CRD (Telegram/Email/Slack config).

## Feature Hubs

- [`features/workflow-recipes.md`](features/workflow-recipes.md) — WorkflowRecipes feature hub — single landing page linking to CRD reference, deploy guide, architecture, security policy, service internals, and historical archive.

## Testing

- [`testing/e2e-guide.md`](testing/e2e-guide.md) — consolidated E2E testing guide (8 suites, 9 phases per suite, approval flow, unit test coverage, desktop-app E2E, troubleshooting).
- Root [`CLAUDE.md`](../CLAUDE.md) §Testing — authoritative per-service test commands.

## Archive & historical artifacts

Point-in-time historical content, consolidated under [`archive/`](archive/). Not actively maintained and may be factually stale — do not rely on any of it for current behavior.

- [`archive/clerum-workflow-recipes/`](archive/clerum-workflow-recipes/) — historical WorkflowRecipes material from the early build-out.
- [`archive/workflow-recipes/`](archive/workflow-recipes/) — historical WorkflowRecipes lessons, troubleshooting, validation notes, and navigation material.
- [`archive/testing/`](archive/testing/) — historical E2E test result snapshots and benchmark material.
- [`archive/misc/`](archive/misc/) — miscellaneous retired content.
- [`research/`](research/) — external framework research (not Clerum-specific; kept separately).

> **Note:** Contributor-local working artifacts live under `docs/superpowers/` on each checkout. They are git-ignored and intentionally not part of the repo.

## Finding things

| I want to… | Start at |
|---|---|
| Run Clerum locally | Root [`CLAUDE.md`](../CLAUDE.md) Minikube section |
| Deploy to GCP | [`deploy/gcp.md`](deploy/gcp.md) |
| Understand the services and CRDs | [`architecture/overview.md`](architecture/overview.md) |
| Configure a WorkflowRecipe CRD | [`crds/workflowrecipe.md`](crds/workflowrecipe.md) or [`features/workflow-recipes.md`](features/workflow-recipes.md) |
| Configure a Host / Context / McpServer / CommunicationChannel CRD | [`crds/host.md`](crds/host.md), [`crds/context.md`](crds/context.md), [`crds/mcpserver.md`](crds/mcpserver.md), [`crds/communicationchannel.md`](crds/communicationchannel.md) |
| Run or troubleshoot E2E tests | [`testing/e2e-guide.md`](testing/e2e-guide.md) |
| Read archived / historical content | [`archive/`](archive/) |
| See a diagram | [`architecture/diagrams/`](architecture/diagrams/) |
| Check NetworkPolicy rules before a security change | Root [`CLAUDE.md`](../CLAUDE.md) NetworkPolicy section and `deploy/base/**/networkpolicies*.yaml` |
