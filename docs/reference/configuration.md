# Configuration reference: feature switches

Most evenfire behaviour is on by default. This page lists the **switches**
whose value differs between `deploy/base` and the minikube overlay, or that
are off by default, so you can see what a fresh `deploy/base` install does
not do yet.

Full per-service variable lists live in each service's README (see
[Where every variable is documented](#where-every-variable-is-documented)).

> **`mcp-host-config` is not in `deploy/base`.** host-context-controller loads
> the `mcp-host-config` ConfigMap into every agent pod with a non-optional
> `envFrom`, so agent pods fail to start (`CreateContainerConfigError`) until
> you create it. Only the minikube overlay ships one
> (`deploy/overlays/minikube/configmaps/mcp-host-config.yaml`); copy it and
> review each value (see [Production deployment](../deploy/production.md)).
> Variables you leave out take mcp-host's code defaults: the mcp-host rows in
> the two "Off" tables below stay off unless your ConfigMap sets them, and the
> mcp-host rows under [On by default](#on-by-default) stay on.

Set boolean switches to the lowercase string `true`. Some services also accept
`1` or other casings, but `true` works everywhere.

## Off in `deploy/base`, on in the minikube overlay

| Switch                                             | Service (where to set it)                  | What it turns on                                                                           | Guide                                                                   |
| -------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `MCP_OAUTH_BROKER_ENABLED`                         | control-api (`control-api-config`)         | OAuth sign-in for MCP connectors; without it OAuth connectors never receive a token        | [Connect an OAuth connector](../how-to/connect-oauth-connector.md)      |
| `CONTROL_API_OAUTH_CALLBACK_BASE_URL`              | control-api (`control-api-config`)         | Browser-reachable origin for OAuth callbacks (a URL, not a boolean)                        | [Connect an OAuth connector](../how-to/connect-oauth-connector.md)      |
| `CONTROL_API_CODEX_SUBSCRIPTION_ENABLED`           | control-api (`control-api-config`)         | ChatGPT (Codex) subscription connections                                                   | [Use a subscription](../how-to/connect-llm-subscription.md)             |
| `CODEX_LLM_PROXY_EXECUTION_ENABLED`                | codex-llm-proxy (`codex-llm-proxy-config`) | Model calls through the Codex proxy                                                        | [Use a subscription](../how-to/connect-llm-subscription.md)             |
| `MCP_HOST_CODEX_SUBSCRIPTION_ENABLED`              | mcp-host (`mcp-host-config`)               | The `codex-subscription` provider in agents                                                | [Use a subscription](../how-to/connect-llm-subscription.md)             |
| `CONTROL_API_GROK_SUBSCRIPTION_ENABLED`            | control-api (`control-api-config`)         | Grok subscription connections (mcp-host's Grok flag is injected per Host)                  | [Use a subscription](../how-to/connect-llm-subscription.md)             |
| `GROK_LLM_PROXY_EXECUTION_ENABLED`                 | grok-llm-proxy (`grok-llm-proxy-config`)   | Model calls through the Grok proxy                                                         | [Use a subscription](../how-to/connect-llm-subscription.md)             |
| `WRC_GROK_SUBSCRIPTION_ENABLED`                    | workflow-recipes (Deployment env)          | Grok in WorkflowRecipe steps                                                               | [Use a subscription](../how-to/connect-llm-subscription.md)             |
| `CLERUM_BUDGETS_ENABLED`                           | mcp-host (`mcp-host-config`)               | Token budget checks before tasks                                                           | [Track usage & set budgets](../how-to/token-budgets-and-usage.md)       |
| `CLERUM_MEMORY_ENABLED`                            | mcp-host (`mcp-host-config`)               | Agent workspace memory                                                                     | [mcp-host README](../../mcp-host/README.md)                             |
| `CLERUM_SESSION_SEARCH_ENABLED`                    | mcp-host (`mcp-host-config`)               | Session search for agents                                                                  | [mcp-host README](../../mcp-host/README.md)                             |
| `CONTROL_API_DESKTOP_GFS_OPERATOR_LINKING_ENABLED` | control-api (`control-api-config`)         | Makes the initial Desktop admin an EvenDrive operator on self-hosted installs              | [GFS operator parity](../architecture/gfs-desktop-operator-parity.md)   |
| `PLUGIN_WORKLOAD_SDK_ENABLED`                      | workflow-recipes (Deployment env)          | The Plugin Workload SDK; WRC passes it to the mcp-host pods of recipes that declare it     | [Plugin Workload SDK upgrade](../deploy/plugin-workload-sdk-upgrade.md) |
| `WRC_ENABLE_SNIPPET_RUNTIME`                       | workflow-recipes (Deployment env)          | Snippet-based workflow coordinators                                                        | [WorkflowRecipes operations](../deploy/workflow-recipes-guide.md)       |
| `WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE`              | workflow-recipes (Deployment env)          | Custom coordinator images (digest-pinned)                                                  | [Workflow SDK](../../packages/workflow-sdk/README.md)                   |
| `CLERUM_NETWORK_POLICY_ENFORCEMENT_CONFIRMED`      | workflow-recipes (Deployment env)          | Confirms the cluster CNI enforces NetworkPolicies (enforcement mode is `required` in both) | [WorkflowRecipes operations](../deploy/workflow-recipes-guide.md)       |
| `REGISTRY_CONNECTION_MODE`                         | control-api (`control-api-config`)         | `self-hosted` in minikube; unset means `managed`                                           | [Connect to the registry](../how-to/connect-to-registry.md)             |
| `CONTEXT_MAPPER_GFSC_UPLOAD_V2_ENABLED`            | host-context-controller (Deployment env)   | The chunked EvenDrive upload protocol                                                      | [Shared & global files](../how-to/shared-and-global-files.md)           |

## Off in both `deploy/base` and the minikube overlay

| Switch                                    | Service                 | What it turns on                                                                           |
| ----------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `CONTROL_API_ENFORCE_IMAGE_ALLOWLIST`     | control-api             | Reject connector images that are not on the allowlist (off: no image check at all)         |
| `CONTEXT_MAPPER_ENFORCE_IMAGE_ALLOWLIST`  | host-context-controller | Block non-allowlisted connector images at reconcile (otherwise logged and allowed)         |
| `SUBSCRIPTION_CATALOG_SYNC_CRON_ENABLED`  | control-api             | Periodic model-catalog refresh for subscription connections                                |
| `OAUTH_PROACTIVE_REFRESH_CRON_ENABLED`    | control-api             | Refresh remote-connector OAuth tokens before they expire                                   |
| `TRACING_APPROVAL_PROMPT_HISTORY_ENABLED` | control-api, mcp-host   | Keep prompt history in approval traces                                                     |
| `CLERUM_PERSONALIZATION_ENABLED`          | mcp-host                | Identity files from `CLERUM_IDENTITY_SEED` at startup when the Host has no personalization |
| `MCP_PROXY_ENABLED`                       | mcp-host                | Route MCP traffic through mcp-proxy                                                        |

## On by default

| Switch                                            | Service                  | Note                                                                          |
| ------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `CLERUM_ENABLE_APPROVAL`                          | mcp-host                 | Human approval gate ([Configure approvals](../how-to/configure-approvals.md)) |
| `LLM_CATALOG_SYNC_CRON_ENABLED`                   | control-api              | models.dev catalog sync; new rows arrive disabled for review                  |
| `CLERUM_ENABLE_RESPONSE_ATTACHMENTS`              | channel-reader, mcp-host | Send generated files back to channels                                         |
| `WRC_ENABLE_DETERMINISTIC`                        | workflow-recipes         | Deterministic workflow steps                                                  |
| `WORKFLOW_APPROVAL_NOTIFICATION_DELIVERY_ENABLED` | control-api              | Deliver workflow approval notifications                                       |

## Where every variable is documented

| Service                          | Reference                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| mcp-host (agent runtime)         | [mcp-host/README.md](../../mcp-host/README.md)                                                                           |
| control-api                      | [control-api/README.md](../../control-api/README.md)                                                                     |
| host-context-controller          | [host-context-controller/README.md](../../host-context-controller/README.md)                                             |
| workflow-recipes                 | [workflow-recipes/README.md](../../workflow-recipes/README.md)                                                           |
| channel-reader                   | [channel-reader/README.md](../../channel-reader/README.md)                                                               |
| rpc-proxy                        | [rpc-proxy/README.md](../../rpc-proxy/README.md)                                                                         |
| external-rest-api                | [external-rest-api/README.md](../../external-rest-api/README.md)                                                         |
| codex-llm-proxy / grok-llm-proxy | [codex-llm-proxy/README.md](../../codex-llm-proxy/README.md), [grok-llm-proxy/README.md](../../grok-llm-proxy/README.md) |
| LLM providers and models         | [Configure LLM providers](../deploy/llm-providers.md)                                                                    |
| Rate limits                      | [Administrative rate limits](../architecture/administrative-rate-limits.md)                                              |
