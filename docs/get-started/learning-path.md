# Learning path

Pick the path that matches what you want to do.

## Path A — Run the platform and message an agent (≈ 20 minutes)

1. [Quickstart](quickstart.md) — `make minikube-setup`, then message the seeded
   `chatllm` agent from the desktop app or the API
2. Optional: connect [Telegram](../how-to/connect-telegram.md)
3. Read [Why evenfire](../concepts/why-evenfire.md)

**Success looks like:** an LLM reply (desktop, API, or Telegram) — and an
approval gate firing when you ask the agent to run a real tool.

## Path B — Understand the platform (≈ 30–60 minutes)

1. [Why evenfire](../concepts/why-evenfire.md) and [When to use evenfire](../concepts/when-to-use-evenfire.md)
2. Root [README security model](../../README.md#security-model)
3. [Architecture overview](../architecture/overview.md) (skim services + message lifecycle)
4. [CRD reference index](../crds/README.md)

**Success looks like:** you can explain Host → Context → McpServer and why
NetworkPolicies matter.

## Path C — Run the full local stack (half day)

1. [Minikube deploy guide](../deploy/minikube.md)
2. [Configure approvals](../how-to/configure-approvals.md)
3. [Add an MCP server](../how-to/add-mcp-server.md)
4. [WorkflowRecipes hub](../features/workflow-recipes.md) if you need multi-workload recipes

**Success looks like:** Control UI up, a Host responding, an approval or
connector path exercised.

## Path D — Contribute

1. [Contributing](../../CONTRIBUTING.md)
2. [Code names](../concepts/code-names.md)
3. Per-service README + `npm test` in the package you touch
4. [E2E guide](../testing/e2e-guide.md) only if you change cross-service behavior

## Path E — Production planning

1. [Production deploy notes](../deploy/production.md)
2. Security model + [SECURITY.md](../../SECURITY.md)
3. License (MPL-2.0) in root [README](../../README.md#community-and-license) and [LICENSE](../../LICENSE)

## Stuck?

See the [FAQ](../faq.md).
