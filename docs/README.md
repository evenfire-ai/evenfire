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
| [Open core: self-host vs hosted](concepts/open-core-and-hosted.md) | What's in this repo vs the managed evenfire hosted service |
| [Code names](concepts/code-names.md)                     | evenfire vs clerum                                                   |
| [Architecture overview](architecture/overview.md)        | Services, CRDs, message lifecycle, NetworkPolicy model               |
| [Platform topology](architecture/platform-topology.md)   | Namespaces, controller split, deny-all baseline                      |
| [Non-MCP services](architecture/non-mcp-services.md)     | Namespace splitting and L0–L3 policy layers                          |
| [Diagrams](architecture/diagrams/)                       | Excalidraw sources                                                   |

## Surfaces (the UIs)

| Doc                                     | Description                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| [Surfaces index](surfaces/README.md)   | Which UI is for whom, and what each may reach                             |
| [Control UI](surfaces/control-ui.md)   | Admin console: usage, budgets, approvals, egress, registry                |
| [Desktop App](surfaces/desktop-app.md) | End-user client: chat, live activity, approvals, artifacts; how to ship it |
| [Profile UI](surfaces/profile-ui.md)   | Member front door: invitation, password, desktop handoff                  |

## How-to guides

| Doc                                                            | Description                         |
| -------------------------------------------------------------- | ----------------------------------- |
| [Connect Telegram](how-to/connect-telegram.md)                 | Minikube env or CRD channel path    |
| [Configure approvals](how-to/configure-approvals.md)           | Human-in-the-loop tool gates        |
| [Add an MCP server](how-to/add-mcp-server.md)                  | Dev-mode JSON or CRD allowlist path |
| [Desktop setup & updates](how-to/desktop-setup-and-updates.md) | Environments, invitation setup, updates |
| [Member invitations on self-hosted](how-to/member-invitations-self-hosted.md) | Hosted mode zero-config emails vs running your own service |
| [Track usage & set budgets](how-to/token-budgets-and-usage.md) | Enable budgets, scope, block vs warn |
| [Connect to the registry](how-to/connect-to-registry.md)       | Self-hosted registry connect flow   |
| [Publish a plugin](how-to/publish-plugin-to-registry.md)       | Publish under your org with an `efrk_` key |
| [Shared & global files](how-to/shared-and-global-files.md)     | Team workspaces (SFS) and the brokered drive (GFS) |
| [Minikube full stack](deploy/minikube.md)                      | Local Kubernetes platform           |
| [Production notes](deploy/production.md)                       | Checklist and in-repo deploy assets |
| [WorkflowRecipes operations](deploy/workflow-recipes-guide.md) | Recipe ops, RBAC, debugging         |

## Reference

| Doc                                                | Description                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [CRD index](crds/README.md)                        | All 8 `clerum.io` CRDs                                                                            |
| [Workflow SDK](../packages/workflow-sdk/README.md) | `@clerum/workflow-sdk` — build custom workflow coordinator images                                 |
| [llms.txt](llms.txt)                               | Machine-readable doc map for coding agents                                                        |
| Service READMEs                                    | One-line map per component in the root [README components list](../README.md#docs-and-components) |

## Testing

| Doc                                                                         | Description                            |
| --------------------------------------------------------------------------- | -------------------------------------- |
| [E2E guide](testing/e2e-guide.md)                                           | Cluster E2E suites, approvals, desktop |
| [Custom coordinator E2E gates](testing/custom-coordinator-e2e-gates.md)     | Gates for custom coordinator images    |
| [Desktop observation smoke test](testing/desktop-observation-smoke-test.md) | Desktop surface smoke check            |

## For coding agents

| Doc                                                             | Description                   |
| --------------------------------------------------------------- | ----------------------------- |
| [WorkflowRecipe guide](agents/CLERUM_WORKFLOW_RECIPE_GUIDE.md)  | Authoring recipes, for agents |
| [Frontend style rules](agents/frontend-style-rules.md)          | CSS tokens, page shells, component rules for the three UIs |
| [WorkflowRecipe naming](architecture/workflow-recipe-naming.md) | Generated resource-name rules |

## Community & trust

| Doc                                            | Description                           |
| ---------------------------------------------- | ------------------------------------- |
| [Contributing](../CONTRIBUTING.md)             | Dev loop, PR rules                    |
| [Security](../SECURITY.md)                     | Private vulnerability reporting       |
| [Claims guardrails](meta/claims-guardrails.md) | Never-overclaim rules for public docs |
| [Governance](../GOVERNANCE.md)                 | How the project is run                |
| [Code of conduct](../CODE_OF_CONDUCT.md)       | Community standards                   |
| [License](../LICENSE)                          | MPL-2.0 (open source)                 |

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
| Use the admin console               | [Control UI](surfaces/control-ui.md)                     |
| Chat with an agent from the desktop | [Desktop App](surfaces/desktop-app.md)                   |

> **Note:** Contributor-local working artifacts live under `docs/superpowers/`
> on each checkout. They are git-ignored and intentionally not part of the repo.
