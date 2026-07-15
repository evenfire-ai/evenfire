# When to use evenfire

evenfire is a self-hostable platform for **multi-channel LLM agents that take
real actions** — with approvals, permissions, and audit-oriented controls built
in. This page describes _categories_ of tools so you can choose the right fit.
It does not rank or name competing products.

## At a glance

|                        | **evenfire**                                      | **Personal assistants**                   | **In-process agent frameworks** |
| ---------------------- | ------------------------------------------------- | ----------------------------------------- | ------------------------------- |
| **Primary job**        | Governed agent _platform_                         | Assistant you message day-to-day          | Library to build agent features |
| **Install metaphor**   | Kubernetes-native (`make minikube-setup` locally) | Single process / gateway                  | `pip` / `npm` into your app     |
| **Config model**       | Kubernetes CRDs + control plane                   | Config files / CLI / skills               | Code-first graphs and crews     |
| **Multi-channel**      | Telegram, email, Slack + desktop                  | Many chat surfaces (often the focus)      | Usually your application’s UI   |
| **Tool governance**    | Context allowlists + NetworkPolicies + approvals  | Approvals / allowlists / sandbox (varies) | Application-defined             |
| **Fleet / org policy** | Hosts, contexts, recipes as reviewable config     | Usually single-user or small team         | Your responsibility             |
| **Best first hour**    | Own an agent runtime; then grow into policy       | Chat tonight with minimal infra           | Embed an agent loop in code     |

## Choose a personal assistant when…

- You want chat surfaces (Telegram, Discord, etc.) with minimal infrastructure
- Skills, memory, and “message it from your phone” matter most
- A single-user or single-node security model is enough

## Choose an in-process framework when…

- Agents are a feature _inside_ your product
- You need custom multi-step graphs or research experiments in code
- You will own deployment, identity, and tool isolation yourself

## Choose evenfire when…

- Agents must call real tools against real systems and you need **policy**
- You want **default-deny networking** and **human approval** as platform
  primitives, not bolt-ons
- Multiple hosts, channels, connectors, and workflows should be **declarative
  and reviewable**
- You will self-host on infrastructure you control (Kubernetes — minikube
  locally, any cluster in production)

## Overlap (honest)

- evenfire also does multi-channel messaging and MCP tools — so do personal
  assistants.
- evenfire includes an agent runtime (`mcp-host`) — it is not “only CRDs.”
- Frameworks can be composed into production systems; evenfire is closer to the
  **control plane** those systems need once actions are real.

## Related

- [Why evenfire](why-evenfire.md)
- [Open core: self-host vs hosted](open-core-and-hosted.md)
- [Security model](../../README.md#security-model)
- [Code names](code-names.md)
