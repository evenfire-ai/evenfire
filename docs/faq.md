# FAQ & troubleshooting

## Product

### What is evenfire?

A self-hostable platform for LLM agents that take real actions: multi-channel
messaging, MCP tools, human-in-the-loop approvals, and default-deny networking,
declared as Kubernetes CRDs. See [Why evenfire](concepts/why-evenfire.md).

### Is it “open source”?

Yes — **MPL-2.0** (Mozilla Public License 2.0), an OSI-approved, file-level
copyleft license. You can use, modify, self-host, and build commercial products
on it; changes to MPL-licensed files must stay under MPL when distributed,
while larger works that combine with this code may carry their own licenses.
See [LICENSE](../LICENSE).

### Why do I keep seeing “clerum”?

Internal code name. Public name is evenfire. See
[Code names](concepts/code-names.md).

### How does evenfire compare to personal assistants or agent libraries?

Personal assistants optimize for chat surfaces and fast individual setup.
In-process frameworks optimize for embedding agents in your application code.
evenfire optimizes for **governed action** on infrastructure you control.
Details (category-level, no product rankings):
[When to use evenfire](concepts/when-to-use-evenfire.md).

## Quickstart

### Setup finished but the agent never replies

- The #1 cause: no real LLM API key in `.env`. Setup infers
  `CLERUM_MODEL_PROVIDER` when exactly one key is set and fails loudly when
  several keys are set without an explicit provider. Fix `.env`, then
  `make minikube-setup ARGS="--skip-build"`.
- `make minikube-status` — every deployment should show READY.
- With `make minikube-pf-all` running:
  `curl -sS http://localhost:8080/v1/runtime/health`.

### The agent answers but has no MCP connectors

Expected for the seeded agent (native tools only). Declare an `McpServer` and
allowlist it in the Context: [Add an MCP server](how-to/add-mcp-server.md).

### Telegram bot ignores me

Your numeric user id must be allowlisted
(`CLERUM_TELEGRAM_USER_ID` in `.env`, or CRD `userIds`). Usernames alone are
not enough. See [Connect Telegram](how-to/connect-telegram.md).

## Platform

### Do I need Kubernetes?

Yes — evenfire is Kubernetes-native; `make minikube-setup` gives you the full
platform on a local cluster in minutes. (Contributors hacking on a single
service can run it standalone in dev mode — see that service's README.)

### Which UI am I supposed to use?

Depends on who you are: **Control UI** if you administer the platform —
admin login, governs the fleet (agents, connectors, budgets, approvals, the
registry). **Desktop App** if you use agents — chat, approvals, artifacts.
**Profile UI** is where an invited member lands to accept an invitation and
set a password, on the way to installing the Desktop App. See the persona
matrix: [Which surface is for me?](surfaces/README.md#which-surface-is-for-me).

### Do I need kubectl to run day-to-day?

No, for day-2 operations: agents, connectors, channels, and approvals all have
Control UI screens, and each one writes the same CRD you would otherwise
apply by hand. Budgets and the registry are Control UI screens too, but
they are **not** CRD-backed: budgets live in control-api's own Postgres, while
the registry catalog lives in a separate registry service that control-api
calls over HTTP (`CLERUM_REGISTRY_URL`). Neither is reachable with
`kubectl apply`. Yes, for install and for GitOps — bootstrapping the
platform is still `make` and `kubectl`. See
[Quickstart](get-started/quickstart.md) and [Production notes](deploy/production.md).

### Can I ship the desktop app to my users?

Yes — `electron-forge` is already configured with makers for
dmg/squirrel/deb/rpm/zip, covering macOS, Windows, and Linux. See
[Ship it to your users](surfaces/desktop-app.md#ship-it-to-your-users).

### How many CRDs are there?

Eight under `clerum.io`: Host, Context, McpServer, CommunicationChannel,
WorkflowRecipe, WorkflowRecipePolicy, SharedFileSystem, GlobalFileSystem.
Index: [CRDs](crds/README.md).

### Approvals never show up

- Host `spec.approval` / `CLERUM_ENABLE_APPROVAL` configured?
- Approver ids match the channel identity?
- Desktop or channel-reader running and able to reach the runtime?
- See [Configure approvals](how-to/configure-approvals.md)

### NetworkPolicy blocks everything

That is the baseline (default deny). Connectivity is added per Context ↔
McpServer. Check `host-context-controller` reconciliation and
[platform topology](architecture/platform-topology.md).

## Contributing & security

### How do I contribute?

[CONTRIBUTING.md](../CONTRIBUTING.md). PRs need tests; third-party MCP servers
and recipes go to the registry, not this monorepo.

### How do I report a vulnerability?

Privately — [SECURITY.md](../SECURITY.md). Do not open a public issue.

## Still stuck?

- [Learning path](get-started/learning-path.md)
- [E2E guide](testing/e2e-guide.md) for cluster validation
- Open a GitHub issue with logs redacted of secrets and tokens
