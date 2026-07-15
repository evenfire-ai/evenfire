# Learning path

Pick the path that matches what you want to do.

## Path A — Run the platform and message an agent (≈ 20 minutes)

1. [Quickstart](quickstart.md) — `make minikube-setup`, then message the seeded
   `chatllm` agent from the desktop app or the API
2. Tour the [Desktop App](../surfaces/desktop-app.md) — screens, live activity,
   in-chat approvals, and artifacts, beyond the one message you just sent.
   To point it at more than one instance or handle updates, see
   [Desktop setup & updates](../how-to/desktop-setup-and-updates.md)
3. Optional: connect [Telegram](../how-to/connect-telegram.md)
4. Read [Why evenfire](../concepts/why-evenfire.md)

**Success looks like:** an LLM reply (desktop, API, or Telegram) — and an
approval gate firing when you ask the agent to run a real tool.

## Path B — Understand the platform (≈ 30–60 minutes)

1. [Why evenfire](../concepts/why-evenfire.md) and [When to use evenfire](../concepts/when-to-use-evenfire.md)
2. Root [README security model](../../README.md#security-model)
3. [Architecture overview](../architecture/overview.md) (skim services + message lifecycle)
4. [Surfaces index](../surfaces/README.md) — the three UIs, who each is for, and
   what each may reach
5. [CRD reference index](../crds/README.md)

**Success looks like:** you can explain Host → Context → McpServer and why
NetworkPolicies matter.

## Path C — Run the full local stack (half day)

1. [Minikube deploy guide](../deploy/minikube.md)
2. [Configure approvals](../how-to/configure-approvals.md)
3. [Add an MCP server](../how-to/add-mcp-server.md)
4. [WorkflowRecipe CRD reference](../crds/workflowrecipe.md) if you need multi-workload recipes

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
4. What's OSS vs the managed service: [Open core: self-host vs hosted](../concepts/open-core-and-hosted.md)

## Stuck?

See the [FAQ](../faq.md).
