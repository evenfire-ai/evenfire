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

### Is multi-tenancy or hosting included?

No. This repo is the full **single-tenant** platform — one organization per
deployment. Multi-tenant provisioning and the hosted registry control plane
belong to the managed **evenfire hosted** service and are not open source.
Member registration is similar — the invitation-signup backend itself is an
extracted sibling service, not open source — but self-hosted deployments don't
need to run it: hosted mode sends invitation emails via evenfire's shared
registration hub with one env var. See [Member invitations on
self-hosted](how-to/member-invitations-self-hosted.md). What you self-host is
complete and not feature-gated. See
[Open core: self-host vs hosted](concepts/open-core-and-hosted.md).

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

- The #1 cause: no real LLM API key in `.env`. With no key, setup gives the
  Host `openai/gpt-5.4-mini` with a placeholder key and warns that the agent
  will not reply. Fix `.env`, then `make minikube-setup REUSE_DB=true ARGS="--skip-build"`.
- How setup picks the Host model: an explicit `CLERUM_MODEL_PROVIDER` wins
  (with `CLERUM_MODEL_NAME`, or that provider's default model). Without it,
  setup takes the provider of the first key present, in the order
  `OPENAI_API_KEY`, `CLAUDE_API_KEY`, `ZAI_API_KEY`, `BAILIAN_API_KEY`, and
  that provider's default model. Several keys do **not** stop setup: the
  first one in that order wins, so set `CLERUM_MODEL_PROVIDER` when that is
  not the provider you want.
- Setup stops (exit 1) when `CLERUM_MODEL_NAME` is set without
  `CLERUM_MODEL_PROVIDER`.
- No model catalog ships with the install: control-api enables models from
  models.dev, so setup needs egress to models.dev and waits for the first
  sync. `CATALOG_SYNC_VENDORED_ONLY` or `CATALOG_SYNC_PENDING` in the output
  means that sync used only the offline snapshot or had not run yet (no egress,
  or `MODELS_DEV_API_URL` unreachable). Nothing is auto-enabled then.
- On minikube, setup adds or enables the Host's model through the admin API in
  Step 10 when the catalog did not (the zai default `glm-5.1` is not on
  models.dev; Bailian models are never auto-enabled). It then stops if the
  model is still not enabled (`HOST_MODEL_UNKNOWN`, `HOST_MODEL_DISABLED`,
  `HOST_MODEL_CHECK_FAILED`), or if the admin API refused
  (`LLM_MODEL_ENSURE_FAILED`). On a reused DB (`REUSE_DB=true`) it does not
  re-enable a model that was already disabled, or re-create one an operator
  removed (`HOST_MODEL_DISABLED`, `HOST_MODEL_DISMISSED`); enable it under
  **LLM models** in the Control UI. `LLM_MODEL_ENSURE_BEFORE_CATALOG` means the
  model was added before the live catalog synced, so it has no catalog price.
  With `--defer-bootstrap-seed` setup only warns (`HOST_MODEL_PENDING`).
  Outside minikube, an admin enables the model by hand. See
  [LLM providers](llm-providers/README.md#47-local-minikube-make-minikube-setup).
- `make minikube-status` — every deployment should show READY.
- With `make minikube-pf-all` running:
  `curl -sS http://localhost:8080/v1/runtime/health`.

### The agent answers but has no MCP connectors

Expected for the seeded agent (native tools only). Declare an `McpServer` and
allowlist it in the Context: [Add an MCP server](how-to/add-mcp-server.md).

### Telegram bot ignores me

The sender must be allowed on the channel: the access list of a channel
created in the Control UI's External Channels page, or the numeric Telegram
user ids in CRD `userIds` (usernames alone are not enough). On minikube,
`.env` Telegram variables do not configure the channel; create it in the
Control UI. See [Connect Telegram](how-to/connect-telegram.md).

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

Nine under `clerum.io`: Host, Context, McpServer, LlmHook, CommunicationChannel,
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
