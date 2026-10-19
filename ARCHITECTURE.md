# Architecture

evenfire is a Kubernetes-native platform for LLM orchestration. Configuration is
driven by Custom Resources under the historical API group `clerum.io`
([code names](docs/concepts/code-names.md)).

This page is the map: every service, where it runs, and which controller creates
it. For the authoritative deep reference — namespaces, trust boundaries,
NetworkPolicy layers, data flows — read:

- **[docs/architecture/platform-topology.md](docs/architecture/platform-topology.md)** — the full platform reference (start here)
- **[docs/architecture/overview.md](docs/architecture/overview.md)** — message lifecycle and deep-dives on `channel-reader`, `mcp-host`, `host-context-controller`
- **[docs/crds/](docs/crds/)** — reference page per CRD
- **[docs/README.md](docs/README.md)** — docs index

## The core idea

Two controllers turn Custom Resources into running workloads. Almost nothing in
the platform is deployed by hand:

| Controller                                                    | Watches                                                                           | Creates                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **[host-context-controller](host-context-controller/)** (HCC) | `Host`, `Context`, `McpServer`, `SharedFileSystem`, `GlobalFileSystem`, `LlmHook` | `mcp-host` pods, MCP server pods (+ `stdio-bridge` sidecar, `nginx-egress-proxy` for remote servers), `workspace-files-controller`, `gfs-controller`, guardrail hook pods in `llm-hooks` (image-target `LlmHook`s only), and the Context/MCP NetworkPolicies |
| **[workflow-recipes](workflow-recipes/)** (WRC)               | `WorkflowRecipe`, `WorkflowRecipePolicy`                                          | sandbox workloads (Deployments/StatefulSets/Jobs/CronJobs), per-recipe `webhook-gateway`, derived `McpServer` CRDs, and the recipe runtime NetworkPolicies                                                                                                   |

Everything else — the UIs, the APIs, the channel readers, the proxies — is
static infrastructure in [`deploy/`](deploy/).

The security posture is **deny-all by default**: every runtime namespace denies
all ingress and egress, and each connection is opened by an explicit
NetworkPolicy owned by whichever component is responsible for that selector.

## Services

### Control plane — `control-plane`

| Service                                             | Role                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [host-context-controller](host-context-controller/) | Reconciles Host / Context / McpServer / SFS / GFS / LlmHook; Discovery REST API                                                                        |
| [workflow-recipes](workflow-recipes/)               | The WorkflowRecipe controller (WRC) — a separate Deployment and image                                                                                  |
| [control-api](control-api/)                         | CRD lifecycle, resource CRUD, profile mapping                                                                                                          |
| [control-ui](control-ui/)                           | Platform management UI                                                                                                                                 |
| [codex-llm-proxy](codex-llm-proxy/)                 | Streams `codex-subscription` model calls to ChatGPT; redeems single-use tickets from control-api. Off by default (`CODEX_LLM_PROXY_EXECUTION_ENABLED`) |
| [grok-llm-proxy](grok-llm-proxy/)                   | Streams `grok-subscription` model calls to Grok; redeems single-use tickets from control-api. Off by default (`GROK_LLM_PROXY_EXECUTION_ENABLED`)      |

### Identity & profiles — `profiles`

| Service                                 | Role                                                           |
| --------------------------------------- | -------------------------------------------------------------- |
| [external-rest-api](external-rest-api/) | User-facing profile, auth, team, invitation, and RPC-token API |
| [profile-ui](profile-ui/)               | User-facing profile management UI                              |

### Channels — `channels`

| Service                                                               | Role                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [channel-reader](channel-reader/)                                     | Receives Telegram / Email / Slack / Teams messages, forwards them to `mcp-host`       |
| [workflow-approval-request-reader](workflow-approval-request-reader/) | Inbound half of channel approvals — receives provider callbacks and submits decisions |

### Agent runtime — `mcp-host`, `mcp-server` (both deny-all)

| Service                                   | Role                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [mcp-host](mcp-host/)                     | The agent: LLM loop, MCP tool calling, state machine, approval gate, queue                                       |
| [mcp-proxy](mcp-proxy/)                   | Optional centralized MCP router (`MCP_PROXY_ENABLED`); discovers servers via HCC                                 |
| [stdio-bridge](stdio-bridge/)             | Sidecar translating stdio MCP transport to StreamableHTTP; injected by HCC                                       |
| [nginx-egress-proxy](nginx-egress-proxy/) | Image only — the pinned egress path HCC deploys for remote (`spec.remote`) MCP servers                           |
| [mcp-servers](mcp-servers/)               | Platform-packaged MCP servers — first-party (Airtable, web-search) plus upstream images (MongoDB, Playwright, …) |

### Recipes & sandbox — `sandbox-recipes`, `sandbox-ui` (both deny-all)

Workloads here are created by the WRC from `WorkflowRecipe` resources, not by
static manifests. `sandbox-ui` holds untrusted recipe-supplied UIs, reachable
only through `rpc-proxy`.

### Guardrail hooks — `llm-hooks` (deny-all)

Holds the pods HCC deploys for image-target [`LlmHook`](docs/crds/llmhook.md)
resources: guardrail services that `mcp-host` calls around LLM and tool calls.
Hooks with the same image and pod settings share one pod. Service and remote
targets deploy nothing here. See
[Configure guardrails](docs/how-to/configure-guardrails.md).

### Files

Both are brokered HTTP file APIs: nothing else mounts the underlying volume, so
every read and write is an authorized, audited API call rather than a raw mount.

| Service                                                   | Namespace                  | Role                                                                                                |
| --------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| [gfs-controller](gfs-controller/)                         | `gfs` (deny-all)           | The GlobalFileSystem drive API — the only workload that mounts the drive PVC                        |
| [workspace-files-controller](workspace-files-controller/) | the SharedFileSystem's own | Per-SharedFileSystem API; the write path for a team workspace (agents mount the same PVC read-only) |

### Edge — `rpc-proxy`, `webhook-ingress`, `ingress` (all deny-all)

| Service                             | Role                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| [rpc-proxy](rpc-proxy/)             | Secure RPC path for the Desktop App → MCP servers / agent (RS256 JWT, scoped tokens)               |
| [webhook-proxy](webhook-proxy/)     | Cluster-shared public webhook router; validates and streams, holds no secrets                      |
| [webhook-gateway](webhook-gateway/) | Per-recipe signature verifier; deployed by WRC into `sandbox-recipes`, sits behind `webhook-proxy` |
| cloudflared                         | Public tunnel ingress                                                                              |

### Clients & libraries

| Component                   | Role                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| [desktop-app](desktop-app/) | Electron + React client; authenticates via `external-rest-api`, calls `rpc-proxy` |
| [packages/](packages/)      | Shared libraries, listed below                                                    |

Shared packages under [`packages/`](packages/) (npm name `@clerum/<dir>`):

| Package                                                                          | Purpose                                                                                             |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [codex-catalog-projection](packages/codex-catalog-projection/)                   | Codex model allowlist snapshot and execution projection, used by HCC, mcp-host and workflow-recipes |
| [desktop-app-links](packages/desktop-app-links/)                                 | `evenfire://app/...` link contract shared by the Desktop App and Profile UI                         |
| [display-field](packages/display-field/)                                         | Validation for free-text display fields (control/bidi characters, length)                           |
| [frontend-components](packages/frontend-components/)                             | React table, record-list and edit-dialog components shared by Control UI and Profile UI             |
| [gfs-interaction-policy](packages/gfs-interaction-policy/)                       | Browser-safe GFS upload naming/collision/retry policy, `FileReference` v1, file classifier          |
| [grok-provider-attempt-contract](packages/grok-provider-attempt-contract/)       | Grok subscription wire contract: limits, origins, request hashing, ticket and receipt types         |
| [image-policy](packages/image-policy/)                                           | Container image reference policy for plugins and workflow coordinators                              |
| [jwt-key-policy](packages/jwt-key-policy/)                                       | RSA JWT key identity policy and local development key storage                                       |
| [llm-provider-attempt-contract](packages/llm-provider-attempt-contract/)         | Codex subscription wire contract: limits, request hashing, ticket and receipt types                 |
| [llm-providers](packages/llm-providers/)                                         | Canonical LLM provider ids, credential slots and display metadata                                   |
| [network-policy-core](packages/network-policy-core/)                             | Sliding-window egress IP accumulation for FQDN NetworkPolicies                                      |
| [workflow-recipe-capability-policy](packages/workflow-recipe-capability-policy/) | Linux capability policy for WorkflowRecipe and McpServer workloads                                  |
| [workflow-runtime-core](packages/workflow-runtime-core/)                         | Internal workflow runtime protocol primitives                                                       |
| [workflow-sdk](packages/workflow-sdk/)                                           | TypeScript SDK for workflow coordinator pods (also built as the `clerum-workflow-base` image)       |

Product-level treatment of `control-ui`, `desktop-app`, and `profile-ui` as the
platform's three human surfaces: [docs/surfaces/README.md](docs/surfaces/README.md).

## CRDs

`Host`, `Context`, `McpServer`, `LlmHook`, `CommunicationChannel`, `WorkflowRecipe`,
`WorkflowRecipePolicy`, `SharedFileSystem`, `GlobalFileSystem` — one reference
page each under [docs/crds/](docs/crds/), shipped in
[charts/clerum-crds](charts/clerum-crds/).

```mermaid
flowchart TB
  user[Telegram / Email / Slack / Teams] --> cr[channel-reader]
  desktop[Desktop App] --> rpc[rpc-proxy]
  cui[control-ui] --> capi
  pui[profile-ui] --> era[external-rest-api]
  hook[Provider webhooks] --> wp[webhook-proxy] --> wg[webhook-gateway]

  cr --> mh[mcp-host]
  rpc --> mh
  wg --> sb[sandbox workloads]

  mh --> mcp[MCP servers]
  mh -->|brokered file API| gfsc[gfs-controller]

  capi[control-api] -->|workspace writes| wfc[workspace-files-controller]
  capi --> crd[(CRDs)]
  era -.mints scoped RPC tokens via.-> capi

  hcc[host-context-controller] -.creates.-> mh
  hcc -.creates.-> mcp
  hcc -.creates.-> gfsc
  hcc -.creates.-> wfc
  wrc[workflow-recipes WRC] -.creates.-> sb
  wrc -.creates.-> wg

  crd -.watched by.-> hcc
  crd -.watched by.-> wrc
```

## Swapping LLM providers

Set `CLERUM_MODEL_PROVIDER` to any of the 24 provider ids in
[`packages/llm-providers`](packages/llm-providers/index.cjs) and supply the
matching credential. One interface, no code change. Minikube setup auto-detects
only `openai`, `claude`, `zai` and `bailian` from their keys. `CLERUM_MODEL_NAME` picks a
model only together with `CLERUM_MODEL_PROVIDER`; minikube setup refuses it
alone and defaults to `openai/gpt-5.4-mini` when no key is set. See
[mcp-host/README.md](mcp-host/README.md) and
[docs/llm-providers/README.md §4.7](docs/llm-providers/README.md#47-local-minikube-make-minikube-setup).

## Security

Product-level model: [README security section](README.md#security-model).  
Reporting: [SECURITY.md](SECURITY.md).
