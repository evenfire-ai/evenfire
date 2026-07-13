# evenfire Documentation

**evenfire** is a self-hostable platform for LLM agents that take real actions:
multi-channel messaging, MCP tools, human-in-the-loop approvals, and
default-deny networking — declared as Kubernetes CRDs.

> Code and API group still use the historical name **clerum** (`clerum.io`,
> `CLERUM_*`). Same project — [code names](concepts/code-names.md).

Start at the root [`README.md`](../README.md) for the product pitch and license.
Use this index for long-form docs.

---

## Get started

| Doc                                           | Description                          |
| --------------------------------------------- | ------------------------------------ |
| [Quickstart](get-started/quickstart.md)       | Full platform on minikube in minutes |
| [Learning path](get-started/learning-path.md) | Choose a path by role and goal       |
| [FAQ](faq.md)                                 | Common questions and troubleshooting |

## Concepts

| Doc                                                      | Description                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| [Why evenfire](concepts/why-evenfire.md)                 | Problem, audience, design intent                                     |
| [When to use evenfire](concepts/when-to-use-evenfire.md) | Fit vs personal assistants / in-process frameworks (categories only) |
| [Code names](concepts/code-names.md)                     | evenfire vs clerum                                                   |
| [Architecture overview](architecture/overview.md)        | Services, CRDs, message lifecycle, NetworkPolicy model               |
| [Platform topology](architecture/platform-topology.md)   | Namespaces, controller split, deny-all baseline                      |
| [Non-MCP services](architecture/non-mcp-services.md)     | Namespace splitting and L0–L3 policy layers                          |
| [Diagrams](architecture/diagrams/)                       | Excalidraw sources                                                   |

## How-to guides

| Doc                                                            | Description                         |
| -------------------------------------------------------------- | ----------------------------------- |
| [Connect Telegram](how-to/connect-telegram.md)                 | Minikube env or CRD channel path    |
| [Configure approvals](how-to/configure-approvals.md)           | Human-in-the-loop tool gates        |
| [Add an MCP server](how-to/add-mcp-server.md)                  | Dev-mode JSON or CRD allowlist path |
| [Minikube full stack](deploy/minikube.md)                      | Local Kubernetes platform           |
| [Production notes](deploy/production.md)                       | Checklist and in-repo deploy assets |
| [WorkflowRecipes operations](deploy/workflow-recipes-guide.md) | Recipe ops, RBAC, debugging         |

## Reference

| Doc                         | Description                                                                 |
| --------------------------- | --------------------------------------------------------------------------- |
| [CRD index](crds/README.md) | All 8 `clerum.io` CRDs                                                      |
| [llms.txt](llms.txt)        | Machine-readable doc map for coding agents                                  |
| Service READMEs             | Linked from root [README repository layout](../README.md#repository-layout) |

## Feature hubs

| Doc                                             | Description                                          |
| ----------------------------------------------- | ---------------------------------------------------- |
| [WorkflowRecipes](features/workflow-recipes.md) | Landing page for the recipe CRD + ops + architecture |

> Other files under `features/` include design-depth writeups (snippet
> coordinators, OAuth bridge, registry UI). Prefer the hubs and how-tos above
> unless you are implementing that subsystem.

## Testing

| Doc                               | Description                            |
| --------------------------------- | -------------------------------------- |
| [E2E guide](testing/e2e-guide.md) | Cluster E2E suites, approvals, desktop |

## Community & trust

| Doc                                            | Description                           |
| ---------------------------------------------- | ------------------------------------- |
| [Contributing](../CONTRIBUTING.md)             | Dev loop, PR rules, CLA               |
| [Security](../SECURITY.md)                     | Private vulnerability reporting       |
| [Claims guardrails](meta/claims-guardrails.md) | Never-overclaim rules for public docs |
| [Governance](../GOVERNANCE.md)                 | How the project is run                |
| [Code of conduct](../CODE_OF_CONDUCT.md)       | Community standards                   |
| [License](../LICENSE)                          | Apache-2.0 + additional use grant     |

## Finding things

| I want to…                           | Start at                                                 |
| ------------------------------------ | -------------------------------------------------------- |
| Chat with a local agent              | [Quickstart](get-started/quickstart.md)                  |
| Understand why this exists           | [Why evenfire](concepts/why-evenfire.md)                 |
| Decide if evenfire fits my use case  | [When to use evenfire](concepts/when-to-use-evenfire.md) |
| Configure Host / Context / McpServer | [CRD index](crds/README.md)                              |
| Run the full stack locally           | [Minikube](deploy/minikube.md)                           |
| Ship to a real cluster               | [Production notes](deploy/production.md)                 |
| Debug E2E                            | [E2E guide](testing/e2e-guide.md)                        |
| Feed docs to an LLM                  | [llms.txt](llms.txt)                                     |

> **Note:** Contributor-local working artifacts live under `docs/superpowers/`
> on each checkout. They are git-ignored and intentionally not part of the repo.
