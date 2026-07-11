---
slug: /
title: What is evenfire?
description: Self-hostable, Kubernetes-native platform for LLM agents — multi-channel, first-class MCP, and a declarative workflow engine.
---

# What is evenfire?

evenfire (internally "Clerum") is a **self-hostable, Kubernetes-native platform
for LLM agents** — multi-channel communication (Telegram, Email, Slack),
first-class MCP (Model Context Protocol) integration, and a declarative
workflow engine. All configuration is driven by Kubernetes Custom Resources
(CRDs) under the `clerum.io` API group.

## Why evenfire

- **CRD-driven, bidirectional MCP** — provision MCP servers declaratively;
  expose your agents over MCP. Not a per-vendor wrapper.
- **WorkflowRecipe engine** — declarative multi-step agentic workflows as
  Kubernetes CRDs.
- **Multi-provider** — OpenAI, Claude, ZAI, Bailian behind one interface.
- **Security by default** — deny-all NetworkPolicy baseline, human approval
  flow for tool calls, per-tenant isolation.

## Start here

| I want to… | Start at |
|---|---|
| Try it in 5 minutes (no Kubernetes) | [Quickstart](getting-started/quickstart.md) |
| Install on Kubernetes | [Installation](getting-started/installation.md) |
| Understand the services and CRDs | [Architecture overview](architecture/overview.md) |
| Configure a Host / Context / McpServer / CommunicationChannel | [CRD reference](crds/README.md) |
| Build a multi-workload agentic workflow | [WorkflowRecipes feature hub](features/workflow-recipes.md) |
| Deploy a full local cluster | [Minikube deployment guide](deploy/minikube.md) |
| Run or troubleshoot E2E tests | [E2E testing guide](testing/e2e-guide.md) |

## Documentation map

### Architecture & design

- [Architecture overview](architecture/overview.md) — full architecture reference (services, CRDs, message lifecycle, NetworkPolicy model, deployment sequence).
- [Platform topology](architecture/platform-topology.md) — 7-namespace topology, HCC/WRC controller split, deny-all security baseline.
- [Non-MCP services](architecture/non-mcp-services.md) — namespace splitting rules and L0–L3 NetworkPolicy layers for non-MCP workloads.
- [WorkflowRecipe naming](architecture/workflow-recipe-naming.md) — naming conventions for recipe-managed resources.

### Deployment & operations

- [Minikube guide](deploy/minikube.md) — full local-cluster deployment (setup, JWT auth chain, WorkflowRecipes config).
- [WorkflowRecipes guide](deploy/workflow-recipes-guide.md) — configuration, operations, and debugging (CRD, Control UI, RBAC, REST API).
- [Workflow output PVC upgrade](deploy/workflow-output-pvc-upgrade.md) — upgrade runbook for workflow output volumes.

### CRD reference

- [CRD index](crds/README.md) — all 6 `clerum.io/v1alpha1` CRDs.
- [Host](crds/host.md) · [Context](crds/context.md) · [McpServer](crds/mcpserver.md) · [WorkflowRecipe](crds/workflowrecipe.md) · [CommunicationChannel](crds/communicationchannel.md)

### Features

- [WorkflowRecipes hub](features/workflow-recipes.md) — single landing page for all WorkflowRecipe content.
- [Context filesystem](features/context-filesystem.md) · [Custom coordinator images](features/custom-coordinator-images.md) · [Snippet runtime](features/custom-coordinator-snippet-runtime.md) · [Snippet workflow](features/custom-coordinator-snippet-workflow.md)
- [Control UI: recipes & registry](features/control-ui-workflow-recipes-and-registry-guide.md) · [OAuth sandbox UI bridge](features/oauth-sandbox-ui-bridge.md) · [Admin desktop workspace provisioning](features/admin-desktop-workspace-provisioning.md) · [AI recipe builder architecture](features/ai-recipe-builder-app-architecture.md)

### Testing

- [E2E guide](testing/e2e-guide.md) — 8 suites, 9 phases per suite, approval flow, troubleshooting.
- [Custom coordinator E2E gates](testing/custom-coordinator-e2e-gates.md) · [Desktop observation smoke test](testing/desktop-observation-smoke-test.md)

### Reference

- [Service catalog](reference/services.md) — every service in the monorepo and the message data flow.
- [LLM providers](reference/llm-providers.md) — supported providers and Host CRD configuration.

## Repository & contributing

- Monorepo layout and per-service READMEs: [github.com/evenfire-ai/evenfire](https://github.com/evenfire-ai/evenfire)
- Developer commands (build, test, minikube): [CLAUDE.md](../CLAUDE.md)
- [Contributing](../CONTRIBUTING.md) · [Security policy](../SECURITY.md) · [Governance](../GOVERNANCE.md)

## License

evenfire is licensed under **Apache-2.0 with an additional use grant** (no
operating a competing managed multi-tenant service). It is **source-available**,
not OSI open source. Self-hosting for your own organization and internal
commercial use are permitted. See [LICENSE](../LICENSE) and
[TRADEMARK.md](../TRADEMARK.md).
