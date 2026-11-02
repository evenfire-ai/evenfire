# MCP Host

MCP Host is a Kubernetes-native service that reads Host CRD configuration and provides LLM access through any of 24 provider ids (OpenAI, Anthropic Claude, Google Vertex AI and Gemini, Amazon Bedrock, Azure OpenAI, OpenAI-compatible APIs, and ChatGPT/Grok subscriptions). It exposes an HTTP RPC endpoint for receiving messages from channel-reader and connects to MCP (Model Context Protocol) servers for tool capabilities.

## Features

- Reads Host CRD from Kubernetes
- Fetches API keys from referenced Kubernetes Secret
- Supports 24 LLM provider ids (see [Supported LLM Providers](#supported-llm-providers))
- Watches for Host CRD changes and reloads configuration
- HTTP RPC server for receiving messages from channel-reader
- Connects to MCP servers via host-context-controller service for tool capabilities
- LLM function calling support (OpenAI tools / Claude tools)
- Built-in document and chart tools: Markdown, PDF, DOCX, XLSX, PPTX, PNG charts and HTML dashboards (see [Document and chart tools](#document-and-chart-tools))
- Dev mode for local development without Kubernetes

## Configuration

### Environment Variables

mcp-host reads its settings from the process environment. Most are read once at
startup (`src/config.ts`), so a change needs a pod restart. Unless a row says
otherwise, an unset variable takes the default shown.

**Source column.** A cluster-mode mcp-host gets its env from three places:

- **HCC**: set per Host by host-context-controller as container `env`
  (`host-context-controller/src/hostReconciler.ts`). These win over the
  ConfigMap.
- **CM**: the shared `mcp-host-config` ConfigMap, loaded with `envFrom` into
  every Host pod (name set by HCC's `CONTEXT_MAPPER_HOST_CONFIGMAP_NAME`).
  `deploy/base` does not ship this ConfigMap and the `envFrom` reference is not
  optional, so you must create it; the minikube overlay ships one in
  `deploy/overlays/minikube/configmaps/mcp-host-config.yaml`. Where the table
  gives a CM value, it is the minikube value.
- **WRC**: set by the workflow-recipe controller on recipe-bound mcp-host pods
  (`workflow-recipes/src/workflow/podFactory.ts`).

**dev** marks local dev-mode settings. A dash means no shipped manifest sets
it. Rows marked _no effect_ are parsed but nothing in the current code reads
the value.

Separately, the per-Host `host-<hostRef>-env` ConfigMap and
`host-<hostRef>-env-secret` Secret are watched at runtime and feed tool
subprocess env, capability checks and the LLM provider's non-secret settings
(`VERTEX_*`, `AWS_REGION`, `AZURE_OPENAI_*`), not the other startup settings
below. Precedence there is host Secret > host ConfigMap > LLM Secret > process
env.

#### Core runtime

| Variable                                 | Default                                                                                                                 | Source                 | Description                                                                                                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERUM_HOST_NAME`                       | `dev-host` unless `NODE_ENV=production`                                                                                 | HCC (Host name); CM    | Host CRD to load. With `NODE_ENV=production` and dev mode off, a missing value stops the Host at startup.                                                                                                                             |
| `CLERUM_NAMESPACE`                       | `default`                                                                                                               | HCC (pod namespace)    | Namespace for Host, Secret and ConfigMap lookups.                                                                                                                                                                                     |
| `NODE_ENV`                               | unset                                                                                                                   | -                      | `production` makes `CLERUM_HOST_NAME` required.                                                                                                                                                                                       |
| `CLERUM_SERVER_PORT`                     | `8080`                                                                                                                  | CM `8080`              | Runtime API listen port.                                                                                                                                                                                                              |
| `CLERUM_WORKSPACE_PATH`                  | process working directory                                                                                               | HCC                    | Root directory for native tools. HCC sets `/config/workspace` for desktop Hosts and its configured workspace path otherwise.                                                                                                          |
| `CLERUM_LLM_SECRET_REF`                  | -                                                                                                                       | HCC (`spec.secretRef`) | _No effect_ in mcp-host; it is in the pod template so a `secretRef` change rolls the pod. mcp-host reads the Secret name from the Host CRD.                                                                                           |
| `CLERUM_CONTEXT_MAPPER_URL`              | `http://host-context-controller-api-gateway.control-plane.svc.cluster.local:8081` (`http://localhost:8081` in dev mode) | CM                     | host-context-controller endpoint that resolves the Host's MCP servers.                                                                                                                                                                |
| `CLERUM_CONTEXT_MAPPER_POLL_INTERVAL`    | `30000`                                                                                                                 | CM `30000`             | Milliseconds between MCP server polls. In cluster mode it must be lower than `HCC_AUTHORITY_MAX_STALENESS_MS` or the Host stops at startup.                                                                                           |
| `HCC_AUTHORITY_MAX_STALENESS_MS`         | `180000` (capped at `600000`)                                                                                           | CM `60000`             | How long the last MCP fleet survives while HCC is unreachable (5xx or transport errors). Identity failures (401/403) revoke at once. An invalid value logs a warning and uses the default. Minikube pins 60000 for its staleness E2E. |
| `CLERUM_MCP_STATUS_HEARTBEAT_INTERVAL`   | `30000`                                                                                                                 | -                      | Milliseconds between MCP status heartbeats. A set value that is not a positive integer stops the Host at startup.                                                                                                                     |
| `CLERUM_MCP_STATUS_HEARTBEAT_TIMEOUT_MS` | `25000`                                                                                                                 | -                      | Timeout for one MCP status heartbeat. Same validation as the interval.                                                                                                                                                                |
| `CLERUM_MAX_CONCURRENT_SESSIONS`         | `3`                                                                                                                     | -                      | Sessions processed at the same time.                                                                                                                                                                                                  |
| `CLERUM_ALLOWED_ORIGINS`                 | empty                                                                                                                   | -                      | Comma-separated CORS origins. Empty sends no `Access-Control-Allow-Origin` header.                                                                                                                                                    |
| `MCP_PROXY_ENABLED`                      | `false`                                                                                                                 | CM `false`             | Send MCP traffic through mcp-proxy instead of connecting to each MCP server directly.                                                                                                                                                 |
| `MCP_PROXY_URL`                          | `http://mcp-proxy.mcp-server.svc.cluster.local:8083` (`http://localhost:8083` in dev mode)                              | CM                     | mcp-proxy address, used when `MCP_PROXY_ENABLED=true`.                                                                                                                                                                                |
| `MCP_HOST_ACTIVITY_BUFFER_SIZE`          | `1000`                                                                                                                  | -                      | Events kept in the Host activity buffer.                                                                                                                                                                                              |
| `MCP_HOST_ACTIVITY_MAX_EVENT_BYTES`      | `2048`                                                                                                                  | -                      | Maximum size of one activity event.                                                                                                                                                                                                   |

#### Auth and runtime tokens

| Variable                                               | Default                         | Source            | Description                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERUM_ENABLE_AUTH`                                   | `true`                          | CM `true`         | Verify RPC JWTs on runtime routes.                                                                                                          |
| `CLERUM_AUTH_JWT_PUBLIC_KEY`                           | empty                           | CM; WRC           | PEM public key for RPC JWTs. Literal `\n` sequences become newlines. Must pair with control-api's RPC signing key.                          |
| `CLERUM_AUTH_JWT_ISSUER`                               | `control-api`                   | CM; WRC           | Expected `iss`.                                                                                                                             |
| `CLERUM_AUTH_JWT_AUDIENCE`                             | `rpc-proxy`                     | CM; WRC           | Expected `aud`. control-api stamps `rpc-proxy` on every RPC token.                                                                          |
| `WRC_PUBLIC_KEY_PEM`                                   | empty                           | WRC               | Public key for workflow-mode tokens (issuer `clerum-wrc`).                                                                                  |
| `MCP_HOST_RUNTIME_ACCESS_TOKEN`                        | empty                           | HCC (Secret); WRC | Runtime access token for platform calls (usage reporting, workflow approval gating, subscription proxies). Never logged or passed to tools. |
| `MCP_HOST_RUNTIME_REFRESH_TOKEN`                       | empty                           | HCC (Secret); WRC | Refresh token for the runtime access token.                                                                                                 |
| `MCP_HOST_WORKFLOW_CONTROL_TOKEN`                      | empty                           | HCC (Secret)      | Token for the workflow tools (`clerum__list_workflows`, `clerum__trigger_workflow`, ...).                                                   |
| `MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE`                 | empty                           | HCC; WRC          | File holding the workflow control token.                                                                                                    |
| `MCP_HOST_GATEWAY_URL`                                 | empty                           | HCC; WRC          | Gateway used for token refresh and workflow calls.                                                                                          |
| `MCP_HOST_RUNTIME_AUTH_STATE_DIR`                      | `/var/run/clerum/workflow-auth` | HCC; WRC          | Directory that stores refreshed runtime tokens.                                                                                             |
| `CLERUM_WORKFLOW_AUTH_STATE_DIR`                       | -                               | -                 | Older name for the same directory; used only when `MCP_HOST_RUNTIME_AUTH_STATE_DIR` is unset.                                               |
| `MCP_HOST_RUNTIME_AUTH_PROACTIVE_REFRESH_ENABLED`      | `true`                          | -                 | Refresh runtime tokens before they expire. Only `false` turns it off.                                                                       |
| `MCP_HOST_RUNTIME_AUTH_PROACTIVE_REFRESH_MARGIN_SEC`   | `600`                           | -                 | Refresh this many seconds before the refresh token expires.                                                                                 |
| `MCP_HOST_RUNTIME_AUTH_PROACTIVE_REFRESH_MIN_SEC`      | `60`                            | -                 | Minimum seconds between proactive refreshes.                                                                                                |
| `MCP_HOST_RUNTIME_AUTH_PROACTIVE_REFRESH_FALLBACK_SEC` | `1800`                          | -                 | Refresh interval when the token expiry cannot be read.                                                                                      |
| `MCP_HOST_RUNTIME_AUTH_DEGRADED_AFTER_FAILURES`        | `3`                             | -                 | Consecutive recovery failures before the runtime-auth degraded gauge is set.                                                                |

#### LLM and models

| Variable                                            | Default                                                       | Source                                             | Description                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider credential env vars                        | -                                                             | dev                                                | In dev mode, each provider's key is read from its env var (`OPENAI_API_KEY`, `CLAUDE_API_KEY`, `ZAI_API_KEY`, `BAILIAN_API_KEY`, ...; Bedrock needs `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`). In cluster mode keys come from the Secret in `Host.spec.secretRef`. Full list: [Supported LLM Providers](#supported-llm-providers). |
| `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`              | `VERTEX_LOCATION`: `us-central1`                              | -                                                  | Non-secret Vertex AI settings. On a Host, set under Host → Environment (per-Host env first, then process env); dev mode reads the process env. `VERTEX_PROJECT_ID` falls back to the service account's `project_id`.                                                                                                                      |
| `AWS_REGION`                                        | -                                                             | -                                                  | Region for Amazon Bedrock (required for Bedrock). On a Host, set under Host → Environment (per-Host env first, then process env); dev mode reads the process env.                                                                                                                                                                         |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION` | -                                                             | -                                                  | Azure OpenAI resource endpoint (required for Azure; must be `https`) and optional API version. On a Host, set under Host → Environment (per-Host env first, then process env); dev mode reads the process env.                                                                                                                            |
| `CLERUM_LLM_ALLOWED_MODELS_CM`                      | `clerum-llm-allowed-models`                                   | -                                                  | Name of the LLM allowlist ConfigMap that control-api writes. A test/canary override only: pointing it at a ConfigMap control-api does not write leaves the Host with no allowed models.                                                                                                                                                   |
| `MCP_HOST_CODEX_SUBSCRIPTION_ENABLED`               | `false`                                                       | CM `true`; WRC                                     | Allow the `codex-subscription` provider. Only the exact value `true` enables it. See [Use a ChatGPT or Grok subscription](../docs/how-to/connect-llm-subscription.md).                                                                                                                                                                    |
| `MCP_HOST_GROK_SUBSCRIPTION_ENABLED`                | `false`                                                       | HCC (only when the Host is eligible for Grok); WRC | Allow the `grok-subscription` provider. HCC adds it only for Hosts whose Grok projection grants execution, so you do not set it in the ConfigMap.                                                                                                                                                                                         |
| `CODEX_LLM_PROXY_RUNTIME_URL`                       | `http://codex-llm-proxy.control-plane.svc.cluster.local:8080` | WRC                                                | codex-llm-proxy address.                                                                                                                                                                                                                                                                                                                  |
| `GROK_LLM_PROXY_RUNTIME_URL`                        | `http://grok-llm-proxy.control-plane.svc.cluster.local:8080`  | WRC                                                | grok-llm-proxy address.                                                                                                                                                                                                                                                                                                                   |
| `CODEX_POLICY_REVISION`, `CODEX_POLICY_HASH`        | `1`, empty                                                    | -                                                  | Test/dev override. Host chat computes the policy digest from the allowlist ConfigMap annotations; an empty hash is not a grant.                                                                                                                                                                                                           |
| `GROK_POLICY_REVISION`, `GROK_POLICY_HASH`          | `1`, empty                                                    | -                                                  | Same, for Grok.                                                                                                                                                                                                                                                                                                                           |
| `CLERUM_PROMPT_CACHE_ENABLED`                       | `true`                                                        | -                                                  | Build the system prompt in cacheable tiers; Anthropic receives `cache_control` markers. Set `false` to roll back.                                                                                                                                                                                                                         |
| `CLERUM_TOKENIZER_DRYRUN`                           | `true`                                                        | -                                                  | Compute both the heuristic and the real token count, but pick the compaction tier from the heuristic (metrics only).                                                                                                                                                                                                                      |
| `CLERUM_TOKENIZER_OFFLINE`                          | `true`                                                        | -                                                  | Skip the Anthropic token-count network call and use the heuristic upper bound.                                                                                                                                                                                                                                                            |
| `MCP_HOST_WORKFLOW_MAX_OUTPUT_TOKENS`               | unset                                                         | -                                                  | Output-token cap for workflow steps, 1 to 65536. An invalid value throws.                                                                                                                                                                                                                                                                 |

#### Agent loop, approvals and budgets

| Variable                            | Default    | Source        | Description                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERUM_AGENT_TASK_DELAY`           | `3`        | CM `3`        | Minimum milliseconds between task dispatches; does not delay tool iterations. `0` disables spacing.                                                                                                                                                             |
| `CLERUM_AGENT_MAX_TASK_DURATION`    | `86400000` | CM `86400000` | Maximum active execution time per task in milliseconds (24 hours), summed across approval resumptions. Approval waiting is excluded.                                                                                                                            |
| `CLERUM_AGENT_MAX_TOOL_CALLS`       | `1000`     | CM `1000`     | Maximum LLM/tool iterations per task; one iteration may call several tools.                                                                                                                                                                                     |
| `CLERUM_AGENT_MAX_QUEUE_SIZE`       | `100`      | CM `100`      | Size of the message queue.                                                                                                                                                                                                                                      |
| `CLERUM_ENABLE_APPROVAL`            | `true`     | -             | Enable the tool approval gate.                                                                                                                                                                                                                                  |
| `CLERUM_APPROVAL_CONFIG`            | unset      | CM            | Approval policy as JSON. Used only when the Host has no `spec.approval`. Example: `{"defaultPolicy":"designated_approvers","channels":{"telegram":{"enabled":true,"approvers":["123456"]}}}`. See [Configure approvals](../docs/how-to/configure-approvals.md). |
| `CLERUM_APPROVAL_TIMEOUT`           | `0`        | CM `0`        | Milliseconds before an unanswered approval is auto-denied. `0` disables the timeout.                                                                                                                                                                            |
| `CLERUM_PENDING_APPROVAL_TTL_HOURS` | `168`      | -             | Lifetime of a stored pending approval (7 days).                                                                                                                                                                                                                 |
| `CLERUM_BUDGETS_ENABLED`            | `false`    | CM `true`     | Enforce token budgets. See [Track usage and set token budgets](../docs/how-to/token-budgets-and-usage.md).                                                                                                                                                      |
| `CLERUM_ENABLE_NUDGE`               | `false`    | -             | _No effect_ in the current code.                                                                                                                                                                                                                                |
| `CLERUM_NUDGE_MAX_ITERATIONS`       | `3`        | -             | _No effect_ in the current code.                                                                                                                                                                                                                                |

#### Tools

| Variable                                   | Default                          | Source        | Description                                                                                                                                                                                                           |
| ------------------------------------------ | -------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERUM_SHELL_TIMEOUT`                     | `1500000`                        | CM `1500000`  | Maximum milliseconds for a shell command. Any value above 2147477647 (value + 6000 ms cleanup > 2^31-1 ms) stops the Host at startup.                                                                                 |
| `CLERUM_TOOL_TIMEOUT`                      | `1500000`                        | CM `1500000`  | Maximum milliseconds for a native tool call. Separate from the MCP timeout below. Same upper bound as `CLERUM_SHELL_TIMEOUT`.                                                                                         |
| `CLERUM_TOOL_PROGRESS_INTERVAL_MS`         | `30000`                          | CM `5000`     | Milliseconds between native-tool progress snapshots. `0` disables them; otherwise a whole number from 1000 to 2147483647. Any other explicit value, including an empty one, stops the Host at startup.                |
| `CLERUM_MCP_TOOL_TIMEOUT_MS`               | `1500000`                        | CM `1500000`  | Per-call timeout for MCP tool requests, still bounded by any caller deadline.                                                                                                                                         |
| `CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS`     | `1500000`                        | CM `1500000`  | Total MCP request budget. Must be a positive integer up to 2147483647 and not lower than `CLERUM_MCP_TOOL_TIMEOUT_MS` (unless the caller passes a shorter timeout); otherwise the tool call fails.                    |
| `CLERUM_HTTP_ALLOWLIST`                    | empty                            | -             | Comma-separated hosts or URLs the `http_request` tool may reach. With an allowlist set you can also skip per-call approval with `tools: { http_request: false }` under `Host.spec.approval`.                          |
| `CLERUM_ENV_ALLOWLIST`                     | `PATH,HOME,USER,SHELL,LANG,TERM` | -             | Comma-separated env vars passed to native tool subprocesses.                                                                                                                                                          |
| `CLERUM_TOOL_SPILLOVER_ENABLED`            | `true`                           | -             | Store large tool results outside the conversation and keep a reference inline. `false` keeps full output inline.                                                                                                      |
| `CLERUM_TOOL_SPILLOVER_THRESHOLD`          | `8192`                           | -             | Bytes above which a tool result spills over. An invalid value stops the Host at startup.                                                                                                                              |
| `CLERUM_SPILLOVER_TTL_HOURS`               | `168`                            | -             | Lifetime of spilled results.                                                                                                                                                                                          |
| `CLERUM_SPILLOVER_GC_INTERVAL_MINUTES`     | `60`                             | -             | Minutes between spillover clean-up sweeps. `0` disables the timer; the startup sweep still runs.                                                                                                                      |
| `CLERUM_NATIVE_TOOL_PRESENTATION`          | `direct`                         | -             | `direct` keeps every native tool in the tool list. `auto` moves native tools whose definition is larger than `CLERUM_NATIVE_TOOL_DISCOVERY_BYTES` behind search/describe/call. Other values stop the Host at startup. |
| `CLERUM_NATIVE_TOOL_DISCOVERY_BYTES`       | `2048`                           | -             | Size budget for one native tool definition in `auto` mode. Validated even in `direct` mode.                                                                                                                           |
| `CODEX_TOOL_PRESENTATION`                  | `direct`                         | -             | Tool presentation when the provider chain includes `codex-subscription` or `grok-subscription`: `auto`, `direct` or `discovery`. Other values stop the Host at startup.                                               |
| `CODEX_TOOL_DISCOVERY_BYTES`               | `32768`                          | -             | Discovery threshold for `CODEX_TOOL_PRESENTATION`. Must be a positive integer.                                                                                                                                        |
| `CLERUM_DYNAMIC_TOOLS_ENABLED`             | `false`                          | -             | Put MCP tools behind search/describe/call for other providers.                                                                                                                                                        |
| `CLERUM_DYNAMIC_TOOLS_THRESHOLD`           | `60`                             | -             | Minimum MCP tool count before dynamic tools turn on.                                                                                                                                                                  |
| `MCP_CATALOG_BOOTSTRAP_ENABLED`            | `true`                           | -             | Open OAuth-backed MCP connections eagerly at the start of a turn, using grant-existence probes. `false` returns to lazy admission.                                                                                    |
| `MCP_CATALOG_BOOTSTRAP_WAIT_BUDGET_MS`     | `4000`                           | -             | Total time a turn waits for probes. Must be larger than the probe timeout.                                                                                                                                            |
| `MCP_CATALOG_BOOTSTRAP_PROBE_TIMEOUT_MS`   | `2000`                           | -             | Timeout for one probe.                                                                                                                                                                                                |
| `MCP_CATALOG_BOOTSTRAP_CONNECT_TIMEOUT_MS` | `8000`                           | -             | Connect timeout for a probed server.                                                                                                                                                                                  |
| `MCP_CATALOG_BOOTSTRAP_NEGATIVE_TTL_MS`    | `15000`                          | -             | How long a "no grant" result is cached.                                                                                                                                                                               |
| `MCP_CATALOG_BOOTSTRAP_FAILURE_TTL_MS`     | `60000`                          | -             | How long a failed probe is cached.                                                                                                                                                                                    |
| `MCP_CATALOG_BOOTSTRAP_PROBES_PER_MIN`     | `20`                             | -             | Probe rate limit. Must stay below 60, the control-api OAuth broker bucket, so probes cannot starve token issuance.                                                                                                    |
| `MCP_CATALOG_BOOTSTRAP_BACKOFF_MS`         | `30000`                          | -             | Back-off after probe failures. All `MCP_CATALOG_BOOTSTRAP_*` numbers stop the Host at startup when invalid.                                                                                                           |
| `CLERUM_DESKTOP_X11`                       | -                                | HCC (desktop) | `true` registers the X11 desktop tools. HCC sets it from `Host.spec.desktop.x11`.                                                                                                                                     |
| `CLERUM_DESKTOP_BROWSER`                   | -                                | HCC (desktop) | `true` registers the browser tools. HCC sets it from `Host.spec.desktop.browser`.                                                                                                                                     |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`      | unset                            | -             | Chromium binary for the browser tools.                                                                                                                                                                                |
| `CLERUM_MEMORY_MAX_SIZE`                   | `1048576`                        | -             | _No effect_ in the current code.                                                                                                                                                                                      |

#### Attachments and files

| Variable                                                                                                                      | Default                                                   | Source        | Description                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLERUM_ENABLE_RESPONSE_ATTACHMENTS`                                                                                          | `true`                                                    | CM `true`     | Pass tool-produced attachments back in responses. `false` disables it for non-workflow responses.                                                                                                                                                                                                                                          |
| `CLERUM_ATTACHMENT_MAX_COUNT`                                                                                                 | `3`                                                       | CM `3`        | Maximum attachments per response.                                                                                                                                                                                                                                                                                                          |
| `CLERUM_ATTACHMENT_MAX_BYTES`                                                                                                 | `52428800` (50 MiB)                                       | CM `52428800` | Maximum decoded size of one outgoing attachment; larger ones are dropped. Also caps workflow result attachments.                                                                                                                                                                                                                           |
| `CLERUM_ATTACHMENT_FILE_MAX_BYTES`                                                                                            | `11534336` (11 MiB, also the ceiling)                     | -             | Maximum decoded bytes per incoming `kind:'file'` attachment. The chat body parser answers HTTP 413 for any larger file; above a lower limit, admission answers `FILE_ATTACHMENT_TOO_LARGE`. Files have a 16 MiB base64 quota; the message share is 6 MiB and the body 24 MiB. An invalid or above-ceiling value stops the Host at startup. |
| `CLERUM_ATTACHMENT_TEXT_READ_MAX_BYTES`                                                                                       | `65536` (64 KiB; up to 1 MiB)                             | -             | Maximum bytes per text page returned by `clerum__attachment_read`. Truncated text continues from its byte offset. Pages stay inline and are exempt from spillover. Bytes are not tokens; do not assume a fixed ratio. An invalid or above-ceiling value stops the Host at startup.                                                         |
| `CLERUM_OUTPUT_DIR`                                                                                                           | see description                                           | -             | Directory for generated files. Unset: `/output` in workflow mode, otherwise `<memory workspace>/outputs`.                                                                                                                                                                                                                                  |
| `CLERUM_WORKFLOW_OUTPUT_QUOTA_MB`                                                                                             | `50`                                                      | -             | Soft quota for generated files in the output directory.                                                                                                                                                                                                                                                                                    |
| `CLERUM_CONTEXT_FILES_MOUNTS`                                                                                                 | -                                                         | HCC           | JSON list of SharedFileSystem mounts for the Host's Context. The context-files tools are registered only when it lists at least one mount.                                                                                                                                                                                                 |
| `CLERUM_CONTEXT_FILES_MAX_READ_BYTES`                                                                                         | `10485760` (10 MiB)                                       | -             | Maximum bytes one context-files read returns.                                                                                                                                                                                                                                                                                              |
| `CLERUM_CONTEXT_FILES_MAX_LIST_ENTRIES`                                                                                       | `1000`                                                    | -             | Maximum entries one context-files listing returns.                                                                                                                                                                                                                                                                                         |
| `MCP_HOST_GFS_MAX_FILE_BYTES`                                                                                                 | `16777216` (16 MiB; up to 200 MiB)                        | CM `16777216` | Maximum size of one GFS file transfer.                                                                                                                                                                                                                                                                                                     |
| `MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT`                                                                                       | `70` (up to 100)                                          | CM `70`       | Share of the workspace volume that retained GFS downloads may use.                                                                                                                                                                                                                                                                         |
| `MCP_HOST_GFS_CALLER_DOWNLOAD_CONCURRENCY`                                                                                    | `1` (up to 2)                                             | CM `1`        | Active GFS downloads per caller.                                                                                                                                                                                                                                                                                                           |
| `MCP_HOST_GFS_DOWNLOAD_TTL_HOURS`                                                                                             | `168` (up to 8760)                                        | CM `168`      | Retention of GFS downloads. All four `MCP_HOST_GFS_*` limits must be positive integers within their ceiling or the Host fails when it loads them.                                                                                                                                                                                          |
| `MCP_HOST_GFS_SCOPES`                                                                                                         | empty                                                     | WRC           | Comma-separated GFS scopes for workflow steps (`gfs.read`, `gfs.write`, `gfs.delete`, `gfs.manage_acl`, `gfs.share`). Any unknown scope empties the set.                                                                                                                                                                                   |
| `MCP_HOST_GFS_TOKEN`, `MCP_HOST_GFS_TOKEN_FILE`                                                                               | file `/var/run/clerum/workflow-tokens/mcp-host-gfs-token` | -             | GFS access token, given directly or as a file path.                                                                                                                                                                                                                                                                                        |
| `MCP_HOST_GFSC_BASE_URL`                                                                                                      | `http://gfsc.gfs.svc.cluster.local:8087`                  | -             | GFS reader endpoint.                                                                                                                                                                                                                                                                                                                       |
| `MCP_HOST_GFSC_WRITER_BASE_URL`                                                                                               | `http://gfsc-writer.gfs.svc.cluster.local:8087`           | -             | GFS writer endpoint.                                                                                                                                                                                                                                                                                                                       |
| `MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES`, `MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES`, `MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES` | -                                                         | -             | Removed. Ignored, with a warning; use `MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT`.                                                                                                                                                                                                                                                             |

#### Sessions, stateless lifecycle and compaction

| Variable                                     | Default    | Source                       | Description                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERUM_SESSION_STORE`                       | `memory`   | CM `sqlite`; HCC (stateless) | Conversation store: `memory` (no durability), `sqlite`, or `dual` (both, for parity checks). Unknown values log a warning and use `memory`.                                                                                                                                                       |
| `CLERUM_SESSION_DB_DIR`                      | empty      | HCC (stateless)              | Directory for `state.db`. Takes precedence over `CLERUM_SESSION_DB_PATH`.                                                                                                                                                                                                                         |
| `CLERUM_SESSION_DB_PATH`                     | empty      | -                            | Explicit `state.db` path. Without either setting the store uses the workspace volume, or a temp file in dev.                                                                                                                                                                                      |
| `CLERUM_STATELESS_LIFECYCLE`                 | `false`    | HCC (stateless)              | Run as a stateless Host: the pod can be suspended and woken by HCC.                                                                                                                                                                                                                               |
| `CLERUM_STATELESS_HEARTBEAT_INTERVAL_MS`     | `30000`    | -                            | Heartbeat cadence HCC uses for suspend decisions. A set value that is not a positive integer stops the Host at startup.                                                                                                                                                                           |
| `CLERUM_POD_UID`                             | empty      | HCC (stateless)              | Pod UID, so HCC can ignore heartbeats from old pods.                                                                                                                                                                                                                                              |
| `CLERUM_STATELESS_ALLOW_CRON_MANAGE`         | `false`    | -                            | Allow `cron_manage` schedules on a stateless Host. Requires `CLERUM_ENABLE_APPROVAL=true` or the Host stops at startup.                                                                                                                                                                           |
| `CLERUM_DB_BARRIER_MODE`                     | empty      | -                            | `full` turns on the fsync barrier for always-on Hosts (stateless Hosts always use it). Empty or `normal` leaves it off; other values stop the Host at startup.                                                                                                                                    |
| `CLERUM_CONVERSATION_CACHE_SIZE`             | `200`      | -                            | Conversations kept in memory by the SQLite store.                                                                                                                                                                                                                                                 |
| `CLERUM_DB_WORKER_HEARTBEAT_MS`              | `5000`     | -                            | SQLite worker heartbeat.                                                                                                                                                                                                                                                                          |
| `CLERUM_DB_PERSIST_SYNC_TIMEOUT_MS`          | `2000`     | -                            | Timeout for a synchronous persist.                                                                                                                                                                                                                                                                |
| `CLERUM_DB_PERSIST_ASYNC_TIMEOUT_MS`         | `5000`     | -                            | Timeout for an asynchronous persist.                                                                                                                                                                                                                                                              |
| `CLERUM_DB_CHECKPOINT_EVERY_WRITES`          | `100`      | -                            | WAL checkpoint frequency, in writes.                                                                                                                                                                                                                                                              |
| `CLERUM_DB_WAL_SIZE_ALARM_BYTES`             | `52428800` | -                            | _No effect_ in the current code.                                                                                                                                                                                                                                                                  |
| `CLERUM_SESSION_TTL_DAYS`                    | `90`       | CM `90`                      | _No effect_ in the current code.                                                                                                                                                                                                                                                                  |
| `CLERUM_SESSION_SEARCH_ENABLED`              | `false`    | CM `true`                    | Enable the `clerum__session_search` tool and REST route. Has effect only when a SQLite-backed store is active.                                                                                                                                                                                    |
| `CLERUM_SEARCH_RETENTION_DAYS`               | `90`       | CM `90`                      | Retention for the search index, applied by a sweep at startup.                                                                                                                                                                                                                                    |
| `CLERUM_CONTEXT_MAX_TOKENS`                  | `100000`   | CM `100000`                  | Token budget for compaction when the model's allowlist row has no context window. `codex-subscription` and `grok-subscription` use 256000 instead; the Host logs `context_window_resolved` with the window and its source. A value that is not a positive integer stops the Host at startup.      |
| `CLERUM_COMPACTION_PRE_PRUNE`                | `true`     | -                            | Master switch for pre-pruning (deduplication, one-lining, JSON truncation, media stripping). It runs once the history reaches the compaction threshold (80% of the context window), before a compaction tier is chosen, and at rehydration under the same threshold. `false` disables every pass. |
| `CLERUM_COMPACTION_PRE_PRUNE_DEDUP`          | `true`     | -                            | Deduplication pass.                                                                                                                                                                                                                                                                               |
| `CLERUM_COMPACTION_PRE_PRUNE_ONE_LINE`       | `true`     | -                            | One-line summary pass.                                                                                                                                                                                                                                                                            |
| `CLERUM_COMPACTION_PRE_PRUNE_JSON_TRUNC`     | `true`     | -                            | JSON truncation pass.                                                                                                                                                                                                                                                                             |
| `CLERUM_COMPACTION_PRE_PRUNE_STRIP_MEDIA`    | `true`     | -                            | Media stripping pass.                                                                                                                                                                                                                                                                             |
| `CLERUM_COMPACTION_PRE_PRUNE_TRUNCATE_BYTES` | `4096`     | -                            | Maximum tool-argument bytes kept by JSON truncation.                                                                                                                                                                                                                                              |
| `CLERUM_COMPACTION_PRE_PRUNE_SUMMARY_TOKENS` | `200`      | -                            | Token size of one-line summaries.                                                                                                                                                                                                                                                                 |
| `CLERUM_COMPACTION_PROTECTED_TAIL_TURNS`     | `3`        | -                            | Most recent turns that pre-pruning never touches.                                                                                                                                                                                                                                                 |
| `CLERUM_COMPACTION_INEFFECTIVE_RATIO`        | `0.9`      | -                            | A compaction that keeps more than this share of tokens counts as ineffective.                                                                                                                                                                                                                     |
| `CLERUM_COMPACTION_INEFFECTIVE_MAX_RUN`      | `2`        | -                            | Consecutive ineffective compactions before compaction stops for the rest of the task.                                                                                                                                                                                                             |
| `CLERUM_COMPACTION_STRUCTURED_SUMMARY`       | `false`    | -                            | Use the structured summary template.                                                                                                                                                                                                                                                              |

#### Memory and personalization

| Variable                         | Default                                  | Source     | Description                                                                                                                              |
| -------------------------------- | ---------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERUM_MEMORY_ENABLED`          | `false`                                  | CM `true`  | Enable workspace memory. The Host CRD has no memory field, so this variable is the only switch.                                          |
| `CLERUM_MEMORY_WORKSPACE_PATH`   | `/workspace` (`./workspace` in dev mode) | -          | Memory workspace directory.                                                                                                              |
| `CLERUM_MEMORY_MD_MAX_BYTES`     | `8192`                                   | -          | Size cap for `MEMORY.md`.                                                                                                                |
| `CLERUM_MEMORY_SCAN_ENABLED`     | `true`                                   | -          | Reject memory writes that match prompt-injection, exfiltration, invisible-Unicode or sensitive-path patterns. Only `false` turns it off. |
| `CLERUM_PERSONALIZATION_ENABLED` | `false`                                  | CM `false` | Seed identity files from `CLERUM_IDENTITY_SEED` at startup when the Host has no `spec.personalization`. Requires memory to be enabled.   |
| `CLERUM_IDENTITY_SEED`           | unset                                    | -          | JSON seed with optional `identity`, `soul`, `agents` and `user` strings (contents for `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `USER.md`). |

#### Guardrails

| Variable                     | Default     | Source | Description                                                                                                                                                                     |
| ---------------------------- | ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERUM_GUARDRAILS_CONFIG`   | unset       | -      | JSON form of `Host.spec.guardrails`, used only when the Host has no `spec.guardrails` (typically dev mode). See [Configure guardrails](../docs/how-to/configure-guardrails.md). |
| `CLERUM_LLM_HOOKS_NAMESPACE` | `llm-hooks` | -      | Namespace where installed LlmHook Services live; guardrail hook endpoints resolve against it.                                                                                   |

#### Workflow and Plugin Workload SDK

These apply to recipe-bound mcp-host pods that WRC creates.

| Variable                                                                     | Default    | Source | Description                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERUM_WORKFLOW_ENABLED`                                                    | `false`    | WRC    | Run in workflow mode.                                                                                                                                                                         |
| `CLERUM_WORKFLOW_RECIPE`, `CLERUM_WORKFLOW_NAMESPACE`                        | empty      | WRC    | Recipe this pod is bound to; workflow requests for another recipe are rejected.                                                                                                               |
| `CLERUM_WORKFLOW_APPROVAL_RECIPE`                                            | empty      | WRC    | Recipe that handles user approval requests.                                                                                                                                                   |
| `CLERUM_WORKFLOW_APPROVAL_RECIPE_NAMESPACE`                                  | `mcp-host` | WRC    | _No effect_ in mcp-host's current code.                                                                                                                                                       |
| `CLERUM_WORKFLOW_MAX_ITERATIONS`                                             | `50`       | -      | LLM/tool rounds per workflow step before forced wrap-up. A step's `maxIterations` overrides it.                                                                                               |
| `CLERUM_MAX_STEP_TIMEOUT_SECONDS`                                            | `5400`     | -      | Ceiling for a step's `timeoutSeconds` (larger values are clamped). Must be 60 to 604800; an invalid value logs a warning and uses the default.                                                |
| `CLERUM_WORKFLOW_RESULT_ARTIFACT_POLL_ATTEMPTS`                              | `180`      | -      | Polls a chat Host makes for a triggered workflow's result artifacts.                                                                                                                          |
| `CLERUM_WORKFLOW_RESULT_ARTIFACT_POLL_INTERVAL_MS`                           | `1000`     | -      | Milliseconds between those polls.                                                                                                                                                             |
| `CLERUM_WRC_URL`                                                             | empty      | WRC    | WRC endpoint, used as the SDK credential broker.                                                                                                                                              |
| `PLUGIN_WORKLOAD_SDK_ENABLED`                                                | `false`    | WRC    | Enable the Plugin Workload SDK server.                                                                                                                                                        |
| `PLUGIN_WORKLOAD_SDK_RUNTIME_MODE`                                           | unset      | WRC    | `workflow` or `sdk-only`. `workflow` requires `CLERUM_WORKFLOW_ENABLED=true`; `sdk-only` requires it `false` and `PLUGIN_WORKLOAD_SDK_ENABLED=true`. Contradictions stop the Host at startup. |
| `PLUGIN_WORKLOAD_SDK_CAPABILITIES`                                           | empty      | WRC    | Comma-separated route families: `promptBridge`, `clientNotifications`. Empty exposes none; an unknown value stops the Host at startup.                                                        |
| `PLUGIN_WORKLOAD_SDK_WORKLOAD_TOKENS_DIR`                                    | empty      | WRC    | Directory of per-caller workload token files.                                                                                                                                                 |
| `PLUGIN_WORKLOAD_SDK_WORKLOAD_TOKEN`, `PLUGIN_WORKLOAD_SDK_BOUND_CALLER_REF` | empty      | dev    | Dev-only single workload token and the caller it binds to.                                                                                                                                    |
| `MCP_HOST_PLUGIN_SDK_PORT`                                                   | `8099`     | -      | SDK server port.                                                                                                                                                                              |
| `MCP_HOST_POD_NAMESPACE`                                                     | empty      | WRC    | Namespace of the recipe pod.                                                                                                                                                                  |
| `CONTROL_API_GATEWAY_URL`                                                    | empty      | -      | Gateway the SDK calls.                                                                                                                                                                        |
| `PLUGIN_WORKLOAD_SDK_PROMPT_TIMEOUT_SECONDS`                                 | `120`      | -      | Timeout for one SDK prompt.                                                                                                                                                                   |
| `PLUGIN_WORKLOAD_SDK_MAX_CONNECTIONS`                                        | `100`      | -      | Total SDK connections.                                                                                                                                                                        |
| `PLUGIN_WORKLOAD_SDK_MAX_CONNECTIONS_PER_WORKLOAD`                           | `10`       | -      | SDK connections per workload.                                                                                                                                                                 |
| `PLUGIN_WORKLOAD_SDK_MAX_RPM_PER_WORKLOAD`                                   | `100`      | -      | Requests per minute per workload.                                                                                                                                                             |
| `PLUGIN_WORKLOAD_SDK_MAX_LLM_RESPONSE_BYTES`                                 | `1048576`  | -      | Maximum LLM response size returned through the SDK.                                                                                                                                           |

`PLUGIN_WORKLOAD_SDK_TOKEN` is not read as a setting. mcp-host only lists it,
with the runtime tokens above and every provider key, as a reserved secret name
that never reaches tool subprocesses or capability output.

#### Observability

| Variable                                    | Default | Source     | Description                                                                          |
| ------------------------------------------- | ------- | ---------- | ------------------------------------------------------------------------------------ |
| `LOG_LEVEL`                                 | `info`  | -          | `debug`, `info`, `warn`, `error` or `silent`.                                        |
| `GOVERNED_TRACING_ENABLED`                  | `true`  | -          | Report governed run traces.                                                          |
| `TRACING_APPROVAL_PROMPT_HISTORY_ENABLED`   | `false` | CM `false` | Capture prompt history with approval traces. Only the exact value `true` enables it. |
| `TRACING_APPROVAL_PROMPT_HISTORY_MAX_BYTES` | `16384` | CM `16384` | Size of captured prompt history, 1024 to 32768.                                      |

#### Dev mode

| Variable                | Default          | Source | Description                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERUM_DEV_MODE`       | `false`          | dev    | Run without Host CRD discovery; host and model come from env.                                                                                                                                                                                                                                                                                                                 |
| `CLERUM_HOST_CONFIG`    | unset            | dev    | Full Host spec as JSON, e.g. `{"host":"dev-host","contextRef":"dev-context","secretRef":"dev-secret","model":{"provider":"openai","name":"gpt-5.4-mini"}}`. Takes precedence over the two variables below.                                                                                                                                                                    |
| `CLERUM_MODEL_PROVIDER` | unset            | dev    | Provider id when `CLERUM_HOST_CONFIG` is not set. An unknown id stops the Host; unset falls back to the first provider whose API key is present.                                                                                                                                                                                                                              |
| `CLERUM_MODEL_NAME`     | provider default | dev    | Model name. Used only together with `CLERUM_MODEL_PROVIDER`; an auto-detected provider keeps its default model.                                                                                                                                                                                                                                                               |
| `CLERUM_MCP_SERVERS`    | unset            | dev    | MCP server definitions as JSON, so you can run without host-context-controller. Each entry needs `name`, `transport`, `enabled` and a `status` object; a server whose `status.ready` is not `true` is skipped. Example: `[{"name":"filesystem","transport":{"type":"streamableHttp","url":"http://localhost:3101"},"enabled":true,"status":{"deployed":true,"ready":true}}]`. |

### Host CRD

The MCP Host reads configuration from a Host CRD:

```yaml
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: chatllm
  namespace: default
spec:
  host: chatLLM
  contextRef: context1
  secretRef: mcp-host-keys # Reference to Secret containing API keys
  model:
    provider: openai # any of the 24 provider ids below
    name: gpt-5.4-mini # Model name
  channels:
    - telegram-channel
    - slack-channel
```

### Supported LLM Providers

Configured via the Host CRD `spec.model.provider` field (or
`CLERUM_MODEL_PROVIDER` in dev mode). There are 24 provider ids, defined in
[`packages/llm-providers/index.cjs`](../packages/llm-providers/index.cjs). The
default model is used when no model name is given. In dev mode the key is read
from the env var shown; in a cluster it comes from the Secret named by
`Host.spec.secretRef`, under the matching lowercase key (for example
`openai-api-key`).

| `provider` value     | Provider                  | Default model                                       | Dev-mode credential env                       |
| -------------------- | ------------------------- | --------------------------------------------------- | --------------------------------------------- |
| `openai`             | OpenAI                    | `gpt-5.4-mini`                                      | `OPENAI_API_KEY`                              |
| `claude`             | Anthropic                 | `claude-sonnet-4-6`                                 | `CLAUDE_API_KEY`                              |
| `zai`                | Z.AI                      | `glm-5.1`                                           | `ZAI_API_KEY`                                 |
| `bailian`            | Bailian                   | `qwen3-coder-plus`                                  | `BAILIAN_API_KEY`                             |
| `vertex`             | Google Vertex AI          | `gemini-2.5-pro`                                    | `VERTEX_SERVICE_ACCOUNT_JSON`                 |
| `bedrock`            | Amazon Bedrock            | `anthropic.claude-sonnet-4-6-v1:0`                  | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` |
| `openrouter`         | OpenRouter                | `anthropic/claude-sonnet-latest`                    | `OPENROUTER_API_KEY`                          |
| `gemini`             | Google Gemini             | `gemini-2.5-flash`                                  | `GEMINI_API_KEY`                              |
| `deepseek`           | DeepSeek                  | `deepseek-v4-flash`                                 | `DEEPSEEK_API_KEY`                            |
| `groq`               | Groq                      | `llama-3.3-70b-versatile`                           | `GROQ_API_KEY`                                |
| `together`           | Together AI               | `meta-llama/Llama-3.3-70B-Instruct-Turbo`           | `TOGETHER_API_KEY`                            |
| `fireworks`          | Fireworks AI              | `accounts/fireworks/models/llama-v3p3-70b-instruct` | `FIREWORKS_API_KEY`                           |
| `mistral`            | Mistral AI                | `mistral-medium-latest`                             | `MISTRAL_API_KEY`                             |
| `xai`                | xAI (Grok)                | `grok-4.3`                                          | `XAI_API_KEY`                                 |
| `cerebras`           | Cerebras                  | `gpt-oss-120b`                                      | `CEREBRAS_API_KEY`                            |
| `deepinfra`          | DeepInfra                 | `deepseek-ai/DeepSeek-V3.2`                         | `DEEPINFRA_API_KEY`                           |
| `perplexity`         | Perplexity                | `sonar-pro`                                         | `PERPLEXITY_API_KEY`                          |
| `moonshot`           | Moonshot (Kimi)           | `kimi-k2.6`                                         | `MOONSHOT_API_KEY`                            |
| `nebius`             | Nebius                    | `Qwen/Qwen3-235B-A22B-Instruct-2507`                | `NEBIUS_API_KEY`                              |
| `novita`             | Novita AI                 | `deepseek/deepseek-v3.2`                            | `NOVITA_API_KEY`                              |
| `minimax`            | MiniMax                   | `MiniMax-M2`                                        | `MINIMAX_API_KEY`                             |
| `azure`              | Azure OpenAI              | `gpt-4.1` (your deployment name)                    | `AZURE_OPENAI_API_KEY`                        |
| `codex-subscription` | OpenAI Codex subscription | none; set a model                                   | none (OAuth sign-in)                          |
| `grok-subscription`  | xAI Grok subscription     | none; set a model                                   | none (OAuth sign-in)                          |

Vertex AI, Bedrock and Azure also need the non-secret settings listed under
[LLM and models](#llm-and-models). The two subscription providers are off by default.
For Codex, set `MCP_HOST_CODEX_SUBSCRIPTION_ENABLED=true` in `mcp-host-config`.
For Grok, set nothing here: HCC adds `MCP_HOST_GROK_SUBSCRIPTION_ENABLED` to each
Host that is eligible for Grok. See
[Use a ChatGPT or Grok subscription](../docs/how-to/connect-llm-subscription.md).
Which providers work in which runtime, and how the model allowlist applies, is
in [LLM providers](../docs/llm-providers/README.md).

Providers are defined data-first in `src/llm/registryCore.ts` — OpenAI-compatible
providers are pure data entries (adding one requires a descriptor, not new code).

On minikube, `make minikube-setup` writes the `chatllm` Host's `spec.model`
from `.env` through `scripts/minikube/host-model.sh`, whose per-provider
defaults are the table above. With no key it uses `openai`/`gpt-5.4-mini`; it
refuses `CLERUM_MODEL_NAME` without `CLERUM_MODEL_PROVIDER` and any pair that is
not an enabled `llm_allowed_models` row. See
[LLM providers §4.7](../docs/llm-providers/README.md#47-local-minikube-make-minikube-setup).

#### Bailian (Alibaba Cloud Model Studio)

Bailian provides access to multiple models through Alibaba Cloud's Coding Plan,
including Qwen, MiniMax, GLM, and Kimi models.

Available models: `qwen3-coder-plus`, `qwen3.5-plus`, `qwen3-coder-next`,
`qwen3-max-2026-01-23`, `MiniMax-M2.5`, `glm-5.1`, `glm-5`, `glm-4.7`, `kimi-k2.5`

**Dev mode:**

```bash
CLERUM_DEV_MODE=true CLERUM_ENABLE_AUTH=false BAILIAN_API_KEY=sk-... CLERUM_MODEL_PROVIDER=bailian npm run dev
```

Get your Coding Plan API key at: https://modelstudio.console.alibabacloud.com/

### Per-Tool Approval Overrides

`Host.spec.approval.tools` is an optional map that overrides each native tool's hard-coded `requiresApproval()` default. Use it to skip per-call approval for tools whose risk you mitigate via a different gate (e.g. `http_request` paired with `CLERUM_HTTP_ALLOWLIST`). `CLERUM_HTTP_ALLOWLIST` is empty by default, and an empty list filters no domains, so set it before you turn off approval for `http_request`.

```yaml
spec:
  approval:
    defaultPolicy: channel_users
    channels:
      telegram: { enabled: true }
    tools:
      http_request: false # skip approval — only safe with a non-empty CLERUM_HTTP_ALLOWLIST
      shell_exec: true # explicit (matches code default; documents intent)
```

Semantics:

- `true` — force approval (override a tool whose code default is `false`).
- `false` — skip approval (override a tool whose code default is `true`).
- absent — use the tool's hard-coded `requiresApproval()` default.

Currently in scope (v1): the always-on native tools — `http_request`, `shell_exec`, `file_read`, `file_write`, `system_info`, `json_transform`, plus `clerum__generate_markdown`, `clerum__generate_pdf`, `clerum__generate_docx`, `clerum__generate_xlsx`, `clerum__generate_pptx`, `clerum__generate_chart`, `clerum__generate_dashboard`, and `clerum__get_capabilities`. The exact list at any deploy is whatever appears after `Always-on tools:` in the `[approval-config]` startup warning. Conditionally-registered tools (`memory_*` when `CLERUM_MEMORY_ENABLED=true`, `cron_*` when a scheduler is wired, `desktop_*` / browser tools when `Host.spec.desktop` is set) are NOT in the startup validator's known set, so an override will trigger an "unknown tool" warning at startup — but the override is still honored at runtime once the tool registers in the per-task `TaskExecutor`. MCP tools (named `serverName__toolName`) are NOT covered by this override and continue to always require approval.

The schema is permissive (`additionalProperties: { type: boolean }`) so adding a new native tool does not require a CRD bump. mcp-host emits an `[approval-config]` warning at startup and on each Host reconcile when an override references an unrecognized tool name or when `http_request: false` is set without `CLERUM_HTTP_ALLOWLIST`. A positive `[approval-config] Per-tool approval overrides in effect: ...` audit log is emitted whenever any override is configured so operators can confirm the CRD took effect.

### Document and chart tools

The `clerum__generate_*` tools write their files to the output folder: `/output` in a workflow run, unless `CLERUM_OUTPUT_DIR` names another, and in chat each caller's own `<workspace>/users/<key>/.clerum-outputs`, which only that caller lists and downloads; `CLERUM_OUTPUT_DIR` is not used in chat. Files written to `<workspace>/outputs` before chat files became per caller stay there, are no longer listed or served, and are counted in a log line at startup. Each generator loads its library on first use.

Charts, PDFs, and the measuring of DOCX tables and slide text read system fonts through `@napi-rs/canvas`, a native module. The images install them: `font-dejavu font-noto font-noto-cjk font-noto-arabic font-noto-hebrew` on Alpine (`Dockerfile`), and `fonts-dejavu-core fonts-noto-core fonts-noto-cjk` on Debian (`Dockerfile.slim`, `Dockerfile.full`, `Dockerfile.desktop`). Without them, the bundled Roboto still draws Latin, Greek and Cyrillic, but CJK, Arabic, Hebrew, arrows and check marks have no glyph to draw. A machine that runs the tests needs the same packages: CI installs the Debian ones for mcp-host, and the font tests fail in CI when they are missing.

### API Keys Secret

Create a Kubernetes Secret containing your API keys:

```bash
kubectl create secret generic mcp-host-keys \
  --from-literal=openai-api-key=sk-xxx \
  --from-literal=claude-api-key=sk-ant-xxx
```

The Secret name is what you reference from `Host.spec.secretRef`.

## Development

### Prerequisites

- Node.js >= 24
- npm
- The fonts listed in [Document and chart tools](#document-and-chart-tools), for the chart and document tools and their tests

### Local Development

1. Install dependencies:

   ```bash
   make install
   ```

2. Run in dev mode with your API key:

   ```bash
   # OpenAI (auto-detected from API key)
   CLERUM_ENABLE_AUTH=false OPENAI_API_KEY=sk-xxx make dev

   # Claude
   CLERUM_ENABLE_AUTH=false CLAUDE_API_KEY=sk-ant-xxx make dev-claude

   # Specific model
   CLERUM_ENABLE_AUTH=false OPENAI_API_KEY=sk-xxx make dev-model MODEL=gpt-5.4-mini
   ```

   You can also export the API key first:

   ```bash
   export OPENAI_API_KEY=sk-xxx CLERUM_ENABLE_AUTH=false
   make dev
   ```

### Build

```bash
make build
```

## Deployment

### Prerequisites

- Kubernetes cluster
- Clerum CRDs installed (`helm install clerum-crds ./charts/clerum-crds`)
- Host CRD created with `secretRef` pointing to your API keys secret

### Deploy to Kubernetes

1. Create the secret with your API keys:

   ```bash
   kubectl create secret generic mcp-host-keys \
     --from-literal=openai-api-key=sk-xxx \
     --from-literal=claude-api-key=sk-ant-xxx
   ```

2. Create a Host CRD:

   ```yaml
   apiVersion: clerum.io/v1alpha1
   kind: Host
   metadata:
     name: chatllm
   spec:
     host: chatLLM
     contextRef: context1
     secretRef: mcp-host-keys
     model:
       provider: openai
       name: gpt-5.4-mini
   ```

3. Build and push the Docker image:

   ```bash
   make docker-build
   make docker-push
   ```

4. That's it — there is no `make deploy`. mcp-host Deployments are never applied
   by hand: host-context-controller reconciles the Host CRD and creates the
   per-Host Deployment, ServiceAccount and Role (`host-<hostRef>-sa`,
   `host-<hostRef>-config-reader`) for you.

### Undeploy

Delete the Host CRD; host-context-controller tears down the per-Host workload it
created.

```bash
kubectl delete host chatllm
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                                    Kubernetes                                     │
│                                                                                   │
│  ┌────────────────┐         ┌─────────────────┐         ┌─────────────────┐      │
│  │ channel-reader │──HTTP───│    mcp-host     │──HTTP───│ host-context-controller │      │
│  │     Pod        │  :8080  │      Pod        │  :8081  │      Pod        │      │
│  └────────┬───────┘         └────────┬────────┘         └────────┬────────┘      │
│           │                          │                           │               │
│           │                          │                           │               │
│           ▼                          ▼                           ▼               │
│  ┌────────────────┐    ┌─────────────┐    ┌─────────────────┐  ┌─────────────┐  │
│  │ Communication  │    │  Host CRD   │    │     Secret      │  │ McpServer   │  │
│  │  Channel CRDs  │    │  (chatllm)  │    │   (API keys)    │  │    CRDs     │  │
│  └────────────────┘    └─────────────┘    └─────────────────┘  └─────────────┘  │
│                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
           │                          │                           │
           ▼                          ▼                           ▼
  ┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
  │ Telegram/Slack/ │        │  OpenAI/Claude  │        │   MCP Servers   │
  │     Email       │        │      APIs       │        │  (filesystem,   │
  └─────────────────┘        └─────────────────┘        │   github, etc)  │
                                                        └─────────────────┘
```

The `host-context-controller` service is responsible for watching McpServer CRDs and providing them to `mcp-host` via REST API. This decouples the mcp-host from direct Kubernetes API access for MCP server discovery.

## Runtime REST API and RPC Callback Mapping

`mcp-host` exposes only versioned runtime REST endpoints under `/v1/runtime/*`.  
Each runtime route is backed by an internal RPCServer callback (`onMessage`, `onStatus`, etc.) except base info/health which are server-native capabilities.

| Capability                     | REST route                                | RPC function                     | Implemented |
| ------------------------------ | ----------------------------------------- | -------------------------------- | ----------- |
| Runtime API metadata           | `GET /v1/runtime`                         | Server-native (`runtimeApiInfo`) | Yes         |
| Health check                   | `GET /v1/runtime/health`                  | Server-native health path        | Yes         |
| Agent/queue status             | `GET /v1/runtime/status`                  | `onStatus(handler)`              | Yes         |
| Message execution              | `POST /v1/runtime/messages`               | `onMessage(handler)`             | Yes         |
| Approve pending tool execution | `POST /v1/runtime/approvals/approve`      | `onApproval(handler)`            | Yes         |
| Deny pending tool execution    | `POST /v1/runtime/approvals/deny`         | `onApproval(handler)`            | Yes         |
| Poll task result               | `GET /v1/runtime/tasks/:taskId/result`    | `onTaskResult(handler)`          | Yes         |
| Read pending cron deliveries   | `GET /v1/runtime/cron/results`            | `onCronResults(handler)`         | Yes         |
| Acknowledge cron delivery      | `DELETE /v1/runtime/cron/results/:taskId` | `onCronResultAck(handler)`       | Yes         |

These routes are not directly callable by end users. Every route above except
`GET /v1/runtime` and `GET /v1/runtime/health` is wrapped in `runtimeEdgeGuard`,
which requires the `x-clerum-edge-caller` header (one of `rpc-proxy`,
`channel-reader`, `workflow-approval-request-reader`), `x-clerum-edge-host-ref`
matching this pod's own host (403 otherwise), and `x-clerum-edge-user-id` when
the caller is `rpc-proxy`. A request carrying an `Authorization` header is
rejected with 401 on these routes. In practice you reach mcp-host through
rpc-proxy or channel-reader, which set those headers; the body below is what
they forward.

### Canonical message request example

```json
{
  "content": "Hello, how are you?",
  "channelType": "telegram",
  "channelId": "-1234567890",
  "sender": "user123",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "messageId": "msg_12345",
  "hostRef": "chatllm",
  "metadata": {}
}
```

`attachments` in responses is optional and enabled by default. Set `CLERUM_ENABLE_RESPONSE_ATTACHMENTS=false` to disable non-workflow response attachment passthrough.

## RBAC

The MCP Host requires the following permissions:

- `get`, `list`, `watch` on `hosts.clerum.io` (to read Host CRD)
- `get` on `secrets` (to read LLM API keys)

Note: McpServer CRD access is handled by the `host-context-controller` service, so mcp-host does not need direct permissions for McpServer resources.

These are not granted by a static manifest. host-context-controller provisions a
per-Host ServiceAccount (`host-<hostRef>-sa`) bound to a narrow Role
(`host-<hostRef>-config-reader`) on every reconcile, scoped to exactly the Host
CRD by name, its env ConfigMap/Secret, and the LLM Secret named by
`spec.secretRef` — so one Host cannot read another Host's resources.

### Long-running task limits

The task keeps one active-time and iteration budget across approval resumptions.
`CLERUM_AGENT_MAX_TASK_DURATION=86400000` allows 24 hours of active execution,
and `CLERUM_AGENT_MAX_TOOL_CALLS=1000` allows at most 1000 agent iterations.
An iteration may call several tools. Waiting for approval consumes neither
budget. Approval snapshots persist consumption and original limits; a restart
cannot replenish them. A lower operator limit applies on restoration, while a
higher ENV value does not enlarge an already-issued budget.

On exhaustion, the task reports an incomplete execution with a structured
`TASK_DURATION_LIMIT` or `TASK_ITERATION_LIMIT` error and retains an interruption
message in the conversation. It does not report successful completion.

Tool, shell and MCP execution defaults are 1500000 ms (25 minutes). Shell
termination starts at the shorter shell/caller deadline, or when the task is
cancelled. The caller permits up to 6 additional seconds for bounded process
termination and result collection (5 seconds for SIGKILL escalation and 1 second
for close delivery); this is cleanup time, not a longer execution allowance.
MCP receives both the caller deadline and cancellation signal. A remote MCP
server must cooperate with cancellation; the Host cannot guarantee remote
side effects stop after the request is cancelled.

Migration 014 marks existing pending approvals as legacy. They cannot silently
receive a new budget: the same task requests a new approval explicitly stating
that prior consumption was not recorded. The old approval and its replay state
are replaced atomically, and no pending tool executes until the new approval
is granted. Newly written or malformed accounting is never treated as legacy.

`CLERUM_AGENT_TASK_DELAY=3` is a 3-millisecond minimum between task dispatches,
not seconds and not a delay between tool iterations. Zero disables dispatch
spacing. Invalid or overflowing execution limits fail configuration validation.

Execution-limit defaults apply only when their environment variable is absent.
Explicit empty strings, whitespace, zero (except task dispatch spacing), malformed
numbers and timer overflows are rejected. Incomplete duration/iteration outcomes
retain already-produced, provenance-checked attachments in the failure response;
this does not turn the interrupted task into a successful completion.
