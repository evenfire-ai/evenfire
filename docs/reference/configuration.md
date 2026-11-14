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
> `HCC_AUTHORITY_MAX_STALENESS_MS` must satisfy the
> [mcp-host authority staleness floor](../deploy/releases-and-upgrades.md#mcp-host-authority-staleness-floor),
> or every agent pod refuses to start.
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
| `LLM_CATALOG_SYNC_CRON_ENABLED`                   | control-api              | models.dev catalog sync; enables eligible new models, capped per run (below)  |
| `LLM_CATALOG_BOOT_SYNC_ENABLED`                   | control-api              | One sync at start when the cron is off, retried until a live, plausible run   |
| `CLERUM_ENABLE_RESPONSE_ATTACHMENTS`              | channel-reader, mcp-host | Send generated files back to channels                                         |
| `WRC_ENABLE_DETERMINISTIC`                        | workflow-recipes         | Deterministic workflow steps                                                  |
| `WORKFLOW_APPROVAL_NOTIFICATION_DELIVERY_ENABLED` | control-api              | Deliver workflow approval notifications                                       |

The catalog sync enables a new model only when its provider's catalog policy is
ON and the model is eligible. One run enables at most
`LLM_CATALOG_AUTO_ENABLE_MAX_PER_PROVIDER_PER_RUN` models per provider
(default 100) and `LLM_CATALOG_AUTO_ENABLE_MAX_PER_RUN` in total (default
is 300); both accept 1–1000, and the rest wait for the next sync run (the cron's next
tick, a manual sync or a restart; with the cron off nothing runs on its own). The newest
releases of a provider go first, and the total is handed out in the fixed
provider order of `PROVIDER_IDS`, so the providers further down wait for the
ones ahead. See
[the model allowlist](../deploy/llm-providers.md#5-the-model-allowlist).

Every replica syncs once at start: as the cron's first tick, or, with the cron
off, on its own unless `LLM_CATALOG_BOOT_SYNC_ENABLED=false` (code default
`true`; only `true` or `false`). A boot sync that got no live, plausible catalog,
or failed, probes models.dev again with backoff (30 s doubling up to 1 h) and
reconciles once it does. `MODELS_DEV_API_URL` must be `https://`, must not point
at an internal host and must not contain credentials; control-api refuses to
start otherwise.

## Bounds on by default

host-context-controller bounds every NetworkPolicy pass with two settings that
`deploy/base` does not set, so their code defaults apply. The table also lists
`HCC_HOST_K8S_REQUEST_TIMEOUT_MS`, which `deploy/base` sets to `30000`, because
it must stay below the hard limit too:

| Variable                          | Default            | Effect                                                                                                                                                                                                       |
| --------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HCC_K8S_REQUEST_TIMEOUT_MS`      | `30000`            | Deadline for each finite Kubernetes request of the NetworkPolicy, McpServer runtime and binding work; a timed-out request fails the pass, which retries. Plain digits, below `HCC_NETPOL_PASS_HARD_LIMIT_MS` |
| `HCC_HOST_K8S_REQUEST_TIMEOUT_MS` | `30000`            | Deadline for each finite Kubernetes request on the Host convergence path. Plain digits, below `HCC_NETPOL_PASS_HARD_LIMIT_MS`                                                                                |
| `HCC_NETPOL_PASS_HARD_LIMIT_MS`   | `1800000` (30 min) | A pass still running at this limit makes HCC exit, so its container restarts and the startup pass converges again; consumers can fail closed before it (see the upgrade note)                                |

See the [upgrade note](../deploy/releases-and-upgrades.md#hcc-networkpolicy-pass-bounds)
and the [HCC README](../../host-context-controller/README.md#networkpolicy).

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
