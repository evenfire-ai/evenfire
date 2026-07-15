# Why evenfire

**Build multi-channel LLM agents you own** — agents that take **real actions**,
with approvals, permissions, and audit-oriented controls built in. Self-host on
your infrastructure; bring your own model keys.

Core idea (product messaging):

> A model can be steered, misled, or simply wrong. So it is never trusted by
> default.

## The problem

Once an agent can call tools (send mail, write data, open a shell, hit APIs),
prompt quality alone is not enough. You need:

- **Who** may talk to the agent (channels, allowlists)
- **What** tools it may reach (connectors, network policy)
- **When** a human must approve (default-on gates)
- **How** the fleet is versioned and reviewed (declarative config)

Personal chat assistants optimize for “message me tonight.” In-process
frameworks optimize for “compose agents in application code.” evenfire
optimizes for **governance around action** when you still want a full agent
runtime and multi-channel surfaces.

## What evenfire optimizes for

1. **Human-in-the-loop by default** — with the approval system on (the default),
   MCP tool calls always pause for explicit approve/deny, as do the risky native
   tools (`shell_exec`, `http_request`, `cron_manage`, `browser_open`,
   `browser_navigate`); pending approvals survive restarts.
2. **Least privilege at the network layer** — a `Context` allowlists MCP
   servers; unlisted servers are unreachable via default-deny NetworkPolicies.
3. **Declarative fleet** — Hosts, channels, connectors, and workflows are
   Kubernetes CRDs (`clerum.io`). Review them like any other infra change.
4. **Model-neutral BYOK** — four providers behind one interface (OpenAI, Claude,
   Z.AI, Bailian); switching is a config change.
5. **Self-hosted data path** — prompts and tool traffic stay on your
   infrastructure.

## Who it is for

- **AI / app developers** building multi-channel agents they operate themselves
- Teams that need Telegram / Slack / email / desktop under shared policy
- Operators who want the full security model from day one — one command
  (`make minikube-setup`) runs the whole platform on a local cluster

## Who it is not for (yet)

- Someone who only wants a single-process personal assistant with one-line
  install and no interest in self-hosted policy
- Developers who only need an in-process agent library inside an existing app
  (no platform control plane)

See [When to use evenfire](when-to-use-evenfire.md) for category-level fit.

## Vocabulary bridge

| You might say       | In this repo                            |
| ------------------- | --------------------------------------- |
| agent               | `Host` CRD + `mcp-host` runtime         |
| governed connector  | `McpServer` scoped by `Context`         |
| plugin / workflow   | `WorkflowRecipe` (+ registry client)    |
| model-neutral, BYOK | four providers; keys in your Secret     |
| shared files        | `SharedFileSystem` + `GlobalFileSystem` |

## Next

- [Quickstart](../get-started/quickstart.md) — try the agent runtime locally
- [Security model](../../README.md#security-model) — four enforcement layers
- [Architecture overview](../architecture/overview.md) — services and lifecycle
- [Open core: self-host vs hosted](open-core-and-hosted.md) — what's in this repo vs the managed service
