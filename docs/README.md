# evenfire Documentation

**evenfire** is a self-hostable platform for LLM agents that take real actions:
multi-channel messaging, MCP tools, human-in-the-loop approvals, and
deny-all-baseline networking — declared as Kubernetes CRDs.

> Code and API group still use the historical name **clerum** (`clerum.io`,
> `CLERUM_*`). Same project — [code names](concepts/code-names.md).

Start at the root [`README.md`](../README.md) for the product pitch and license.
Use this index for long-form docs. User and operator pages describe what
`deploy/base` and the minikube overlays ship; features that are off by default
say so. [Design records](#design-records) are point-in-time and not maintained.

---

## Get started

| Doc                                                       | Description                                                                 |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Quickstart](get-started/quickstart.md)                   | Full platform on minikube: set `.env`, one command                          |
| [Registry quickstart](get-started/registry-quickstart.md) | Connect, install, and publish as a self-hoster                              |
| [Dev mode](get-started/dev-mode.md)                       | Run mcp-host alone without Kubernetes (contributors; not platform security) |
| [Learning path](get-started/learning-path.md)             | Choose a path by role and goal                                              |
| [FAQ](faq.md)                                             | Common questions and troubleshooting                                        |

## Concepts

| Doc                                                                | Description                                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| [Why evenfire](concepts/why-evenfire.md)                           | Problem, audience, design intent                                     |
| [When to use evenfire](concepts/when-to-use-evenfire.md)           | Fit vs personal assistants / in-process frameworks (categories only) |
| [A tool call, end to end](concepts/tool-call-end-to-end.md)        | From a user request through approval to the artifact                 |
| [Open core: self-host vs hosted](concepts/open-core-and-hosted.md) | What's in this repo vs the managed evenfire hosted service           |
| [Code names](concepts/code-names.md)                               | evenfire vs clerum                                                   |
| [Architecture overview](architecture/overview.md)                  | Services, CRDs, message lifecycle, NetworkPolicy model               |
| [Platform topology](architecture/platform-topology.md)             | Namespaces, controller split, deny-all baseline                      |
| [Non-MCP services](architecture/non-mcp-services.md)               | Namespace splitting and L0–L3 policy layers                          |

## Surfaces (the UIs)

| Doc                                    | Description                                                                |
| -------------------------------------- | -------------------------------------------------------------------------- |
| [Surfaces index](surfaces/README.md)   | Which UI is for whom, and what each may reach                              |
| [Control UI](surfaces/control-ui.md)   | Admin console: usage, budgets, approvals, egress, marketplace, guardrails  |
| [Desktop App](surfaces/desktop-app.md) | End-user client: chat, live activity, approvals, artifacts; how to ship it |
| [Profile UI](surfaces/profile-ui.md)   | Member front door: invitation, password, desktop handoff                   |

## How-to guides

| Doc                                                                           | Description                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [Connect Telegram](how-to/connect-telegram.md)                                | Minikube env or CRD channel path                                          |
| [Connect Slack](how-to/connect-slack.md)                                      | Slack app scopes, request URL, conversation verification                  |
| [Connect Microsoft Teams](how-to/connect-teams.md)                            | Teams CLI bot registration, endpoint, conversation verify                 |
| [Use the Desktop App](how-to/use-the-desktop-app.md)                          | Daily use: chat, attachments, approvals, EvenDrive, shortcuts, deep links |
| [Configure guardrails](how-to/configure-guardrails.md)                        | Tool-call rules, installed guardrail hooks, built-ins                     |
| [Connect an OAuth connector](how-to/connect-oauth-connector.md)               | Remote/OAuth MCP servers, Microsoft 365 (Entra ID), user auth, secrets    |
| [Configure approvals](how-to/configure-approvals.md)                          | Human-in-the-loop tool gates                                              |
| [Add an MCP server](how-to/add-mcp-server.md)                                 | Dev-mode JSON, CRD, or Control UI path                                    |
| [Desktop setup & updates](how-to/desktop-setup-and-updates.md)                | Environments, invitation setup, updates                                   |
| [Manage users and teams](how-to/manage-users-and-teams.md)                    | Members, teams, roles, control admins, agent access                       |
| [Member invitations on self-hosted](how-to/member-invitations-self-hosted.md) | Hosted mode zero-config emails vs running your own service                |
| [Track usage & set budgets](how-to/token-budgets-and-usage.md)                | Enable budgets, scope, block vs warn                                      |
| [Connect to the registry](how-to/connect-to-registry.md)                      | Self-hosted registry connect flow                                         |
| [Publish a plugin](how-to/publish-plugin-to-registry.md)                      | Publish under your org with an `efrk_` key                                |
| [Shared & global files](how-to/shared-and-global-files.md)                    | Team workspaces (SFS) and the brokered drive (EvenDrive / GFS)            |

## LLM providers

| Doc                                                                      | Description                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| [LLM providers overview](llm-providers/README.md)                        | The 24 providers, mental model, support matrix, request flow, fallback |
| [Configure LLM providers](deploy/llm-providers.md)                       | Operator guide: credentials, Vertex/Bedrock/Azure, allowlist, selector |
| [Use a ChatGPT or Grok subscription](how-to/connect-llm-subscription.md) | Sign in with a subscription instead of an API key (off by default)     |
| [Add an LLM provider](llm-providers/adding-a-provider.md)                | Data-only vs driver-based integration paths                            |

## Deploy & operate

| Doc                                                                              | Description                                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [Minikube full stack](deploy/minikube.md)                                        | In-depth reference for the local platform                        |
| [Production notes](deploy/production.md)                                         | Checklist and in-repo deploy assets                              |
| [WorkflowRecipes operations](deploy/workflow-recipes-guide.md)                   | Recipe ops, RBAC, debugging                                      |
| [Releases and upgrades](deploy/releases-and-upgrades.md)                         | Versioning, release images, pinning a release, upgrade order     |
| [Monitoring and observability](operations/monitoring.md)                         | Logs starter, metrics endpoints, health checks, what to alert on |
| **Upgrade notes**                                                                |                                                                  |
| [Workflow output PVC upgrade](deploy/workflow-output-pvc-upgrade.md)             | Per-recipe output PVC ownership change                           |
| [Plugin Workload SDK upgrade](deploy/plugin-workload-sdk-upgrade.md)             | promptBridge / clientNotifications rollout order and migration   |
| [Host PVC layout upgrade](deploy/host-pvc-layout-upgrade.md)                     | Upgrading stateless Hosts from v0.10.x / v0.11.x                 |
| **Runbooks**                                                                     |                                                                  |
| [GFS permission store](deploy/gfs-permission-store.md)                           | `gfs_controller` DB credential: provisioning, rotation, recovery |
| [Password work ownership recovery](how-to/password-work-ownership-recovery.md)   | Recover the bcrypt work-bounding singleton                       |
| [MCP secret rollback permits](how-to/control-api-mcp-secret-rollback-permits.md) | Short-lived permits for the legacy MCP secret rollback path      |
| [GFS large-file downloads](operations/gfs-large-file-host-downloads.md)          | GFS admission limits vs visual model input                       |

## Reference

| Doc                                                  | Description                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Configuration switches](reference/configuration.md) | Feature flags that differ between `deploy/base` and minikube, and where each service's variables are documented |
| [Plugin UI SDK](reference/plugin-ui-sdk.md)          | `window.clerum` API for plugin apps embedded in the Desktop App                                                 |
| [CRD index](crds/README.md)                          | All 9 `clerum.io` CRDs                                                                                          |
| [Workflow SDK](../packages/workflow-sdk/README.md)   | `@clerum/workflow-sdk` — build custom workflow coordinator images                                               |
| [llms.txt](llms.txt)                                 | Machine-readable doc map for coding agents                                                                      |
| Service READMEs                                      | One-line map per component in the root [README components list](../README.md#docs-and-components)               |

## Architecture deep dives

Design-level explanations of specific subsystems. Read the overview first.

| Doc                                                                                                | Description                                                         |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [Diagrams](architecture/diagrams/)                                                                 | Excalidraw sources                                                  |
| [Stateless agent invariants](architecture/stateless-invariants.md)                                 | Guardrails for the suspend/wake agent lifecycle                     |
| [Host storage layout](architecture/host-storage-layout.md)                                         | Workspace PVC layout, merge init, database failures, rollback rule  |
| [HCC readiness flows](architecture/hcc-readiness-flows.md)                                         | Probe vs data-path readiness in host-context-controller             |
| [Live entity-change semantics](architecture/live-entity-change-consumer-semantics.md)              | Latest-state convergence contract for live UI updates               |
| [Governed tracing](architecture/governed-tracing.md)                                               | Control-plane evidence of what agents, admins, controllers did      |
| [Administrative rate limits](architecture/administrative-rate-limits.md)                           | Control API quotas and how the UIs handle throttling                |
| [GFS desktop operator parity](architecture/gfs-desktop-operator-parity.md)                         | Initial Desktop identity as EvenDrive operator on self-hosted       |
| [Registry pull secrets: self-provisioning](architecture/registry-pull-secret-self-provisioning.md) | How a self-hosted install provisions its registry image-pull Secret |
| [Registry pull secrets: recipe workloads](architecture/registry-pull-secret-recipe-workloads.md)   | Extending that pull Secret to WorkflowRecipe workloads              |
| [Codex subscription transport contract](architecture/codex-subscription-transport-contract.md)     | Wire contract for the `codex-subscription` provider                 |
| [Grok subscription transport contract](architecture/grok-subscription-transport-contract.md)       | Wire contract and flags for `grok-subscription`                     |
| [WorkflowRecipe naming](architecture/workflow-recipe-naming.md)                                    | Generated resource-name rules                                       |

## Testing & contributor runbooks

Contributor-facing. Most assume a local development cluster and the lanes in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

| Doc                                                                                  | Description                                         |
| ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| [E2E guide](testing/e2e-guide.md)                                                    | Cluster E2E suites, approvals, desktop              |
| [Minikube T0/T1/T2 runbook](testing/minikube-t2-runbook.md)                          | The validation-lane contract                        |
| [Custom coordinator E2E gates](testing/custom-coordinator-e2e-gates.md)              | Gates for custom coordinator images                 |
| [Desktop observation smoke test](testing/desktop-observation-smoke-test.md)          | Desktop surface smoke check                         |
| [Control UI headful journeys](testing/control-ui-headful-journeys.md)                | Optional Playwright QA recorder for Control UI      |
| [Desktop headful journeys](testing/desktop-headful-journeys.md)                      | Optional Playwright QA recorder for the Desktop App |
| [Codex subscription validation](testing/codex-subscription-validation.md)            | Evidence lanes for `codex-subscription`             |
| [Grok subscription validation](testing/grok-subscription-validation.md)              | Evidence lanes for `grok-subscription` image input  |
| [Workflow NetworkPolicy regressions](testing/workflow-network-policy-regressions.md) | Ownership rules learned from workflow policy bugs   |
| [Stateless idle calibration](testing/stateless-idle-calibration.md)                  | Measuring the stateless time-to-idle                |
| [Local measurements](testing/local-measurements.md)                                  | Running benchmarks through the intake gate          |
| [CodeQL rate-limiting dispositions](how-to/codeql-js-missing-rate-limiting.md)       | Audited dispositions for `js/missing-rate-limiting` |

## For coding agents

| Doc                                                            | Description                                     |
| -------------------------------------------------------------- | ----------------------------------------------- |
| [WorkflowRecipe guide](agents/CLERUM_WORKFLOW_RECIPE_GUIDE.md) | Authoring recipes, for agents                   |
| [Shared frontend rules](agents/frontend-style-rules.md)        | Cross-app rules for the three frontend surfaces |
| [Control UI rules](agents/control-ui-rules.md)                 | Control UI application-specific guidance        |
| [Profile UI rules](agents/profile-ui-rules.md)                 | Profile UI application-specific guidance        |
| [Desktop renderer rules](agents/desktop-ui-rules.md)           | Desktop renderer application guidance           |

## Design records

Point-in-time design notes and inventories, kept for context and not maintained
as user docs: [design/](design/README.md).

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
| Pick or configure an LLM provider    | [LLM providers overview](llm-providers/README.md)        |
| Run the full stack locally           | [Minikube](deploy/minikube.md)                           |
| Ship to a real cluster               | [Production notes](deploy/production.md)                 |
| Upgrade an existing install          | [Releases and upgrades](deploy/releases-and-upgrades.md) |
| Debug E2E                            | [E2E guide](testing/e2e-guide.md)                        |
| Feed docs to an LLM                  | [llms.txt](llms.txt)                                     |
| Use the admin console                | [Control UI](surfaces/control-ui.md)                     |
| Chat with an agent from the desktop  | [Desktop App](surfaces/desktop-app.md)                   |

> **Note:** Contributor-local working artifacts live under `docs/superpowers/`
> on each checkout. They are git-ignored and intentionally not part of the repo.
