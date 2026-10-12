# Single-service dev mode

Dev mode runs `mcp-host` (the agent runtime) as a plain Node process, with no
Kubernetes cluster. Use it to iterate on the agent loop, a model provider, a
native tool, guardrails or an MCP server.

> **Dev mode is not full platform security.** It turns off JWT verification
> and runs without NetworkPolicies, CRDs, host-context-controller, control-api
> or the UIs. Do not expose a dev-mode process to a network you do not trust.
> For the full platform, use the [Quickstart](quickstart.md).

## Run mcp-host locally

You need Node.js 24 and an API key for one
[supported provider](../llm-providers/README.md).

```bash
cd mcp-host
npm ci
npm run build

CLERUM_DEV_MODE=true \
CLERUM_ENABLE_AUTH=false \
OPENAI_API_KEY=sk-... \
npm start
```

`npm start` runs `node dist/main.js`. The server listens on port `8080`
(`CLERUM_SERVER_PORT` changes it). Check it is up:

```bash
curl -s http://localhost:8080/v1/runtime/health
# {"status":"ok"}
```

`CLERUM_ENABLE_AUTH=false` is required. Auth defaults to on, and with auth on
mcp-host refuses to start unless `CLERUM_AUTH_JWT_PUBLIC_KEY` is set:
`FATAL: enableAuth=true but CLERUM_AUTH_JWT_PUBLIC_KEY is not set`.

## Choose the model

In dev mode there is no Host CRD and no Kubernetes Secret. The Host spec and
the API keys come from environment variables:

| Variable                                                                                 | Effect                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider key (`OPENAI_API_KEY`, `CLAUDE_API_KEY`, `ZAI_API_KEY`, `BAILIAN_API_KEY`, ...) | At least one is required, or startup fails. The full list is in [mcp-host Supported LLM Providers](../../mcp-host/README.md#supported-llm-providers). |
| `CLERUM_MODEL_PROVIDER`                                                                  | Provider id to use. An unknown id stops startup. Unset: the first provider whose key is present is used, with its default model.                      |
| `CLERUM_MODEL_NAME`                                                                      | Model name. Used only together with `CLERUM_MODEL_PROVIDER`.                                                                                          |
| `CLERUM_HOST_CONFIG`                                                                     | A full Host spec as JSON. Takes precedence over the two variables above.                                                                              |
| `CLERUM_HOST_NAME`                                                                       | Host name. Defaults to `dev-host`.                                                                                                                    |

## Send a message

`GET /v1/runtime`, `GET /v1/runtime/health`, `GET /v1/runtime/live` and
`GET /metrics` are open. The other runtime routes (messages, approvals, status,
task results and the rest) check the edge headers that rpc-proxy and channel-reader set in a real
deployment. Dev mode keeps that check, so a bare request gets
`401 {"error":"Missing runtime edge caller context"}`.

To call mcp-host directly, send the headers channel-reader would send. The
channel headers must match the body, and `x-clerum-edge-host-ref` must match
the Host name (`dev-host` by default):

```bash
curl -s -X POST http://localhost:8080/v1/runtime/messages \
  -H 'content-type: application/json' \
  -H 'x-clerum-edge-caller: channel-reader' \
  -H 'x-clerum-edge-host-ref: dev-host' \
  -H 'x-clerum-edge-channel-type: http' \
  -H 'x-clerum-edge-channel-id: local' \
  -H 'x-clerum-edge-sender: me' \
  -d '{"content":"hi","channelType":"http","channelId":"local","sender":"me","hostRef":"dev-host"}'
```

The call waits for the turn to finish and returns the reply. Add `?async=true`
to get a `taskId` back at once and poll `GET /v1/runtime/tasks/:taskId/result`
instead. See the
[runtime REST API](../../mcp-host/README.md#runtime-rest-api-and-rpc-callback-mapping)
for the other routes.

## What works

- **The agent loop and native tools.** Tool calls run on your machine, as
  your user. The memory workspace defaults to `./workspace` (relative to where
  you start mcp-host) instead of `/workspace`; `CLERUM_MEMORY_WORKSPACE_PATH`
  changes it.
- **Approvals.** The approval gate is on by default. Set the policy with
  `CLERUM_APPROVAL_CONFIG` (the JSON form of `Host.spec.approval`). Without
  it, the approval resolver allows no approver, and `CLERUM_APPROVAL_TIMEOUT`
  defaults to `0` (never time out), so a tool that needs approval waits
  forever. For local iteration, either set `CLERUM_APPROVAL_CONFIG` or turn
  the gate off with `CLERUM_ENABLE_APPROVAL=false`. Decisions go to
  `POST /v1/runtime/approvals/approve` and `POST /v1/runtime/approvals/deny`,
  which need the same edge headers as messages. See
  [Configure approvals](../how-to/configure-approvals.md).
- **Guardrails.** Set `CLERUM_GUARDRAILS_CONFIG` to the JSON form of
  `Host.spec.guardrails`. See
  [Configure guardrails](../how-to/configure-guardrails.md).
- **MCP servers.** There is no host-context-controller to discover them, so
  list them in `CLERUM_MCP_SERVERS`. See
  [Add an MCP server, Option A](../how-to/add-mcp-server.md#option-a--mcp-host-dev-mode-contributors-no-cluster).
- **A chat channel.** channel-reader also has a dev mode that reads its
  channel config from `CLERUM_CHANNEL` and needs a real bot token. Point it at
  mcp-host with `CLERUM_MCP_HOST_URL`, and set `CLERUM_HOST_REF` to the
  mcp-host Host name (`dev-host` by default). channel-reader's own dev
  default is `dev`, which mcp-host rejects with `403`. See
  [channel-reader](../../channel-reader/README.md#dev-mode).

Each of these variables is read at startup, so restart mcp-host after you
change one. The full list is in the
[mcp-host environment reference](../../mcp-host/README.md#environment-variables).

## What does not work

| Missing                                  | Why                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| JWT verification                         | `CLERUM_ENABLE_AUTH=false`, and there is no control-api or rpc-proxy in front of mcp-host to issue or check tokens.      |
| NetworkPolicies                          | There is no cluster. Native tools and MCP servers reach whatever your machine can reach.                                 |
| CRDs and controllers                     | No Host, Context, McpServer or WorkflowRecipe objects, and no host-context-controller. Changing them needs the platform. |
| Secrets                                  | Provider keys are plain environment variables.                                                                           |
| control-api, Control UI, the Desktop App | They need the full platform. Users, usage, OAuth connectors and LLM subscriptions are managed through control-api.       |

## Run it in Docker

`mcp-host/Dockerfile` builds from the repository root, because mcp-host links
shared packages from `packages/`:

```bash
# from the repository root
docker build -f mcp-host/Dockerfile -t mcp-host-dev .
docker run --rm -p 8080:8080 \
  -e CLERUM_DEV_MODE=true \
  -e CLERUM_ENABLE_AUTH=false \
  -e OPENAI_API_KEY=sk-... \
  mcp-host-dev
```

The root `docker-compose.yml` declares the same dev-mode settings, plus an
optional channel-reader under the `telegram` profile. Its mcp-host build does
not work as written: it uses `context: ./mcp-host`, so the Dockerfile cannot
find `packages/`. Use the commands above instead.
