# FAQ & troubleshooting

## Product

### What is evenfire?

A self-hostable platform for LLM agents that take real actions: multi-channel
messaging, MCP tools, human-in-the-loop approvals, and default-deny networking,
declared as Kubernetes CRDs. See [Why evenfire](concepts/why-evenfire.md).

### Is it “open source”?

It is **source-available** under Apache-2.0 **with an additional use grant**
(no competing multi-tenant managed service without a commercial license). That
is **not** an OSI-approved open-source license. Self-hosting for your own
organization is allowed. See [LICENSE](../LICENSE).

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

### Compose is up but curl fails

- Confirm health: `curl -sS http://localhost:8080/v1/runtime/health`
- Prefer `./scripts/dev/quickstart-chat.sh "Hello"`
- Ensure you send the `x-clerum-edge-*` headers in dev mode
- Confirm `.env.quickstart` has a valid key and provider

### The agent answers but has no tools

Expected in default quickstart. Wire `CLERUM_MCP_SERVERS` or use the Kubernetes
path: [Add an MCP server](how-to/add-mcp-server.md).

### Telegram bot ignores me

Your numeric user id must be allowlisted
(`TELEGRAM_ALLOWED_USER_ID` or CRD `userIds`). Usernames alone are not enough.
See [Connect Telegram](how-to/connect-telegram.md).

## Platform

### Do I need Kubernetes?

| Goal                                          | Need K8s?           |
| --------------------------------------------- | ------------------- |
| Try the LLM agent runtime                     | No — Docker Compose |
| Approvals + NetworkPolicies + full CRDs + UIs | Yes                 |

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
