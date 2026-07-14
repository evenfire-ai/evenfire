# MCP Host

MCP Host is a Kubernetes-native service that reads Host CRD configuration and provides LLM access via OpenAI, Anthropic Claude, Z.AI, or Alibaba Bailian. It exposes an HTTP RPC endpoint for receiving messages from channel-reader and connects to MCP (Model Context Protocol) servers for tool capabilities.

## Features

- Reads Host CRD from Kubernetes
- Fetches API keys from referenced Kubernetes Secret
- Supports OpenAI, Anthropic Claude, Z.AI, and Bailian providers (see [Supported LLM Providers](#supported-llm-providers))
- Watches for Host CRD changes and reloads configuration
- HTTP RPC server for receiving messages from channel-reader
- Connects to MCP servers via host-context-controller service for tool capabilities
- LLM function calling support (OpenAI tools / Claude tools)
- Dev mode for local development without Kubernetes

## Configuration

### Environment Variables

| Variable                               | Explanation                                                                                                                                                                                                                                                 | Canonical example                                                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERUM_DEV_MODE`                      | Enables local/dev bootstrap mode that bypasses Host CRD discovery and reads host/runtime config from env.                                                                                                                                                   | `CLERUM_DEV_MODE=true`                                                                                                                                                                             |
| `CLERUM_HOST_NAME`                     | Selects which Host CRD to load in production mode; in non-production fallback it defaults to `dev-host`.                                                                                                                                                    | `CLERUM_HOST_NAME=chatllm`                                                                                                                                                                         |
| `CLERUM_NAMESPACE`                     | Sets the Kubernetes namespace used for Host and Secret lookup when running in cluster mode.                                                                                                                                                                 | `CLERUM_NAMESPACE=mcp-host`                                                                                                                                                                        |
| `CLERUM_SERVER_PORT`                   | Sets the HTTP listen port for the runtime API server.                                                                                                                                                                                                       | `CLERUM_SERVER_PORT=8080`                                                                                                                                                                          |
| `CLERUM_CONTEXT_MAPPER_URL`            | Points to the host-context-controller endpoint used to resolve MCP servers for a context.                                                                                                                                                                   | `CLERUM_CONTEXT_MAPPER_URL=http://host-context-controller-api-gateway.control-plane.svc.cluster.local:8081`                                                                                        |
| `CLERUM_CONTEXT_MAPPER_POLL_INTERVAL`  | Controls polling interval (milliseconds) for MCP server config changes from context mapper.                                                                                                                                                                 | `CLERUM_CONTEXT_MAPPER_POLL_INTERVAL=30000`                                                                                                                                                        |
| `CLERUM_HOST_CONFIG`                   | Provides a full Host spec as JSON in dev mode, overriding provider/model context env composition.                                                                                                                                                           | `CLERUM_HOST_CONFIG={"host":"dev-host","contextRef":"dev-context","secretRef":"dev-secret","model":{"provider":"openai","name":"gpt-5.4-mini"}}`                                                   |
| `CLERUM_MODEL_PROVIDER`                | Chooses the model provider in dev mode when `CLERUM_HOST_CONFIG` is not set.                                                                                                                                                                                | `CLERUM_MODEL_PROVIDER=openai`                                                                                                                                                                     |
| `CLERUM_MODEL_NAME`                    | Overrides the default provider model name in dev mode.                                                                                                                                                                                                      | `CLERUM_MODEL_NAME=gpt-5.4-mini`                                                                                                                                                                   |
| `CLERUM_MCP_SERVERS`                   | Supplies dev MCP server definitions as JSON so you can run without context mapper. Each entry needs `name`, `contextRef`, `transport`, `enabled`, and a `status` object — a server whose `status.ready` is not `true` is parsed but skipped as "not ready". | `CLERUM_MCP_SERVERS=[{"name":"filesystem","contextRef":"dev-context","transport":{"type":"streamableHttp","url":"http://localhost:3101"},"enabled":true,"status":{"deployed":true,"ready":true}}]` |
| `CLERUM_MCP_TOOL_TIMEOUT_MS`           | Per-call timeout passed to MCP SDK `Client.callTool(...)` requests. The effective timeout is still bounded by any caller workflow or snippet step budget.                                                                                                   | `CLERUM_MCP_TOOL_TIMEOUT_MS=3600000`                                                                                                                                                               |
| `CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS` | Maximum total MCP SDK tool-call budget used at the SDK request boundary. Operators may tune it up to the existing workflow step ceiling; invalid values fail closed at runtime.                                                                             | `CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS=3600000`                                                                                                                                                     |
| `OPENAI_API_KEY`                       | OpenAI API key used by dev mode when provider selection resolves to OpenAI.                                                                                                                                                                                 | `OPENAI_API_KEY=sk-xxxx`                                                                                                                                                                           |
| `CLAUDE_API_KEY`                       | Anthropic API key used by dev mode when provider selection resolves to Claude.                                                                                                                                                                              | `CLAUDE_API_KEY=sk-ant-xxxx`                                                                                                                                                                       |
| `ZAI_API_KEY`                          | ZAI API key used by dev mode when provider selection resolves to ZAI.                                                                                                                                                                                       | `ZAI_API_KEY=zai-xxxx`                                                                                                                                                                             |
| `BAILIAN_API_KEY`                      | Bailian API key used by dev mode when provider selection resolves to Bailian/Qwen.                                                                                                                                                                          | `BAILIAN_API_KEY=ba-xxxx`                                                                                                                                                                          |
| `CLERUM_AGENT_TASK_DELAY`              | Delay in milliseconds between queued task processing attempts in the state machine loop.                                                                                                                                                                    | `CLERUM_AGENT_TASK_DELAY=100`                                                                                                                                                                      |
| `CLERUM_AGENT_MAX_TASK_DURATION`       | Maximum task runtime in milliseconds before task execution is treated as timed out.                                                                                                                                                                         | `CLERUM_AGENT_MAX_TASK_DURATION=1800000`                                                                                                                                                           |
| `CLERUM_AGENT_MAX_TOOL_CALLS`          | Hard cap on tool calls per task to prevent unbounded tool loops.                                                                                                                                                                                            | `CLERUM_AGENT_MAX_TOOL_CALLS=50`                                                                                                                                                                   |
| `CLERUM_AGENT_MAX_QUEUE_SIZE`          | Maximum pending queue size before new tasks are rejected/back-pressured.                                                                                                                                                                                    | `CLERUM_AGENT_MAX_QUEUE_SIZE=100`                                                                                                                                                                  |
| `CLERUM_ENABLE_APPROVAL`               | Enables the approval gate workflow for tool execution decisions.                                                                                                                                                                                            | `CLERUM_ENABLE_APPROVAL=true`                                                                                                                                                                      |
| `CLERUM_APPROVAL_CONFIG`               | JSON config for approval policy/channels when not sourced from Host CRD.                                                                                                                                                                                    | `CLERUM_APPROVAL_CONFIG={"defaultPolicy":"designated_approvers","channels":{"telegram":{"enabled":true,"approvers":["123456"]}}}`                                                                  |
| `CLERUM_ENABLE_NUDGE`                  | Enables the nudge controller that pushes model/tool retry guidance when output is rejected.                                                                                                                                                                 | `CLERUM_ENABLE_NUDGE=false`                                                                                                                                                                        |
| `CLERUM_NUDGE_MAX_ITERATIONS`          | Maximum number of nudge cycles allowed for a task.                                                                                                                                                                                                          | `CLERUM_NUDGE_MAX_ITERATIONS=3`                                                                                                                                                                    |
| `CLERUM_CONTEXT_MAX_TOKENS`            | Token budget used by context compaction logic before pruning/summarization.                                                                                                                                                                                 | `CLERUM_CONTEXT_MAX_TOKENS=100000`                                                                                                                                                                 |
| `CLERUM_WORKSPACE_PATH`                | Base workspace path used by native tools and workspace-aware operations.                                                                                                                                                                                    | `CLERUM_WORKSPACE_PATH=/workspace`                                                                                                                                                                 |
| `CLERUM_SHELL_TIMEOUT`                 | Maximum execution time in milliseconds for shell native-tool commands.                                                                                                                                                                                      | `CLERUM_SHELL_TIMEOUT=600000`                                                                                                                                                                      |
| `CLERUM_TOOL_TIMEOUT`                  | Maximum execution time in milliseconds for native tool wrapper calls. This is separate from the MCP SDK request timeout controlled by `CLERUM_MCP_TOOL_TIMEOUT_MS`.                                                                                         | `CLERUM_TOOL_TIMEOUT=660000`                                                                                                                                                                       |
| `CLERUM_HTTP_ALLOWLIST`                | Comma-separated allowlist of outbound hosts/URLs allowed for HTTP native tools. With an allowlist set, you can also skip per-call approval by adding `tools: { http_request: false }` under `Host.spec.approval` (see Host CRD).                            | `CLERUM_HTTP_ALLOWLIST=api.github.com,example.com`                                                                                                                                                 |
| `CLERUM_ENV_ALLOWLIST`                 | Comma-separated list of environment variables forwarded into native tool execution contexts.                                                                                                                                                                | `CLERUM_ENV_ALLOWLIST=PATH,HOME,USER,SHELL,LANG,TERM`                                                                                                                                              |
| `CLERUM_MEMORY_MAX_SIZE`               | Maximum bytes reserved for in-memory native tool buffers/state.                                                                                                                                                                                             | `CLERUM_MEMORY_MAX_SIZE=1048576`                                                                                                                                                                   |
| `CLERUM_ENABLE_RESPONSE_ATTACHMENTS`   | Enables attachment passthrough in runtime responses when tools return supported media.                                                                                                                                                                      | `CLERUM_ENABLE_RESPONSE_ATTACHMENTS=true`                                                                                                                                                          |
| `CLERUM_ATTACHMENT_MAX_COUNT`          | Maximum number of attachments returned per response.                                                                                                                                                                                                        | `CLERUM_ATTACHMENT_MAX_COUNT=3`                                                                                                                                                                    |
| `CLERUM_ATTACHMENT_MAX_BYTES`          | Maximum decoded size per attachment in bytes (oversized payloads are dropped).                                                                                                                                                                              | `CLERUM_ATTACHMENT_MAX_BYTES=52428800`                                                                                                                                                             |
| `CLERUM_MEMORY_ENABLED`                | Enables workspace memory persistence features.                                                                                                                                                                                                              | `CLERUM_MEMORY_ENABLED=true`                                                                                                                                                                       |
| `CLERUM_MEMORY_WORKSPACE_PATH`         | Sets workspace directory path used when memory mode is enabled.                                                                                                                                                                                             | `CLERUM_MEMORY_WORKSPACE_PATH=/workspace`                                                                                                                                                          |
| `CLERUM_PERSONALIZATION_ENABLED`       | Enables identity/personalization seeding behavior.                                                                                                                                                                                                          | `CLERUM_PERSONALIZATION_ENABLED=true`                                                                                                                                                              |
| `CLERUM_IDENTITY_SEED`                 | JSON identity seed used to initialize personalization artifacts when enabled.                                                                                                                                                                               | `CLERUM_IDENTITY_SEED={"displayName":"Clerum Agent","tone":"concise"}`                                                                                                                             |
| `NODE_ENV`                             | Influences production checks and defaults (for example strict host-name requirement in production).                                                                                                                                                         | `NODE_ENV=production`                                                                                                                                                                              |

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
    provider: openai # or "claude", "zai", "bailian"
    name: gpt-5.4-mini # Model name
  channels:
    - telegram-channel
    - slack-channel
```

### Supported LLM Providers

Configured via the Host CRD `spec.model.provider` field (or
`CLERUM_MODEL_PROVIDER` in dev mode):

| Provider                             | `provider` value | Default Model       | API                     |
| ------------------------------------ | ---------------- | ------------------- | ----------------------- |
| OpenAI                               | `openai`         | `gpt-5.4-mini`      | OpenAI Chat Completions |
| Anthropic Claude                     | `claude`         | `claude-sonnet-4-6` | Anthropic Messages      |
| ZAI (z.ai)                           | `zai`            | `glm-5.1`           | OpenAI-compatible       |
| Alibaba Cloud Model Studio (Bailian) | `bailian`        | `qwen3-coder-plus`  | OpenAI-compatible       |

Providers are defined data-first in `src/llm/registryCore.ts` — OpenAI-compatible
providers are pure data entries (adding one requires a descriptor, not new code).

#### Bailian (Alibaba Cloud Model Studio)

Bailian provides access to multiple models through Alibaba Cloud's Coding Plan,
including Qwen, MiniMax, GLM, and Kimi models.

Available models: `qwen3-coder-plus`, `qwen3.5-plus`, `qwen3-coder-next`,
`qwen3-max-2026-01-23`, `MiniMax-M2.5`, `glm-5.1`, `glm-5`, `glm-4.7`, `kimi-k2.5`

**Dev mode:**

```bash
CLERUM_DEV_MODE=true BAILIAN_API_KEY=sk-... CLERUM_MODEL_PROVIDER=bailian npm run dev
```

Get your Coding Plan API key at: https://modelstudio.console.alibabacloud.com/

### Per-Tool Approval Overrides

`Host.spec.approval.tools` is an optional map that overrides each native tool's hard-coded `requiresApproval()` default. Use it to skip per-call approval for tools whose risk you mitigate via a different gate (e.g. `http_request` paired with `CLERUM_HTTP_ALLOWLIST`).

```yaml
spec:
  approval:
    defaultPolicy: channel_users
    channels:
      telegram: { enabled: true }
    tools:
      http_request: false # skip approval — relies on CLERUM_HTTP_ALLOWLIST as the gate
      shell_exec: true # explicit (matches code default; documents intent)
```

Semantics:

- `true` — force approval (override a tool whose code default is `false`).
- `false` — skip approval (override a tool whose code default is `true`).
- absent — use the tool's hard-coded `requiresApproval()` default.

Currently in scope (v1): the always-on native tools — `http_request`, `shell_exec`, `file_read`, `file_write`, `system_info`, `json_transform`, plus `clerum__generate_markdown`, `clerum__generate_pdf`, `clerum__generate_docx`, `clerum__generate_xlsx`, `clerum__list_workflows`, `clerum__read_workflow`, `clerum__trigger_workflow`, and `clerum__get_capabilities`. The exact list at any deploy is whatever appears after `Always-on tools:` in the `[approval-config]` startup warning. Conditionally-registered tools (`memory_*` when `CLERUM_MEMORY_ENABLED=true`, `cron_*` when a scheduler is wired, `desktop_*` / browser tools when `Host.spec.desktop` is set) are NOT in the startup validator's known set, so an override will trigger an "unknown tool" warning at startup — but the override is still honored at runtime once the tool registers in the per-task `TaskExecutor`. MCP tools (named `serverName__toolName`) are NOT covered by this override and continue to always require approval.

The schema is permissive (`additionalProperties: { type: boolean }`) so adding a new native tool does not require a CRD bump. mcp-host emits an `[approval-config]` warning at startup and on each Host reconcile when an override references an unrecognized tool name or when `http_request: false` is set without `CLERUM_HTTP_ALLOWLIST`. A positive `[approval-config] Per-tool approval overrides in effect: ...` audit log is emitted whenever any override is configured so operators can confirm the CRD took effect.

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

### Local Development

1. Install dependencies:

   ```bash
   make install
   ```

2. Run in dev mode with your API key:

   ```bash
   # OpenAI (auto-detected from API key)
   OPENAI_API_KEY=sk-xxx make dev

   # Claude
   CLAUDE_API_KEY=sk-ant-xxx make dev-claude

   # Specific model
   OPENAI_API_KEY=sk-xxx make dev-model MODEL=gpt-5.4-mini
   ```

   You can also export the API key first:

   ```bash
   export OPENAI_API_KEY=sk-xxx
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
