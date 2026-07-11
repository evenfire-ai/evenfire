---
title: Installation
description: Install the evenfire CRDs with Helm and deploy the full platform on Kubernetes.
---

# Installation

The full evenfire platform runs on Kubernetes: all configuration is driven by
Custom Resources (CRDs) under the `clerum.io` API group, reconciled by the
platform's operators.

## Prerequisites

- A Kubernetes cluster (minikube for local development, GKE or any conformant
  cluster for production).
- `kubectl` configured for the target cluster.
- [Helm](https://helm.sh/) 3.x.
- For NetworkPolicy enforcement (recommended — the platform ships a deny-all
  baseline): a CNI that enforces NetworkPolicies, e.g. Calico.

## 1. Install the CRDs (Helm)

```bash
helm install clerum-crds ./charts/clerum-crds
```

This installs all six `clerum.io/v1alpha1` CRDs:

| Resource                 | Description                                                                 |
| ------------------------ | --------------------------------------------------------------------------- |
| **CommunicationChannel** | Channels (Telegram, Email, Slack) with allowed user identifiers.            |
| **Context**              | Logical scope that groups a host and its MCP servers.                       |
| **Host**                 | Central agent entity (LLM provider config, context + secret refs).          |
| **McpServer**            | MCP server deployment spec (image, transport, auth, env, security).         |
| **WorkflowRecipe**       | Multi-workload composition with MCP server registration.                    |
| **WorkflowRecipePolicy** | Governance and detection policy for WorkflowRecipe deployments.             |

See [charts/clerum-crds/README.md](../../charts/clerum-crds/README.md) for chart details.

## 2. Apply example resources (optional)

```bash
kubectl apply -f charts/clerum-crds/examples/
```

The [examples directory](../../charts/clerum-crds/examples/) contains sample
Context, Host, McpServer, and WorkflowRecipe resources you can adapt.

## 3. Deploy the platform services

Follow the full deployment guide for your target:

- [Minikube deployment guide](../deploy/minikube.md) — local cluster with the
  complete stack (operators, NetworkPolicies, JWT auth chain, WorkflowRecipes).

## Next steps

- [CRD reference](../crds/README.md) — configure each resource.
- [Platform topology](../architecture/platform-topology.md) — the 7-namespace
  layout and security baseline.
- [E2E testing guide](../testing/e2e-guide.md) — validate your deployment.
