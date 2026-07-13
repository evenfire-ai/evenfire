# Workflow Approval Request Reader

The inbound half of channel-based workflow approvals. Approval prompts are
delivered to Slack/Telegram by other platform components; this service receives
the provider callbacks that come back — approval button clicks, enrollment
messages, and Slack chat messages — normalizes them, and submits decisions to
the right workflow-runtime mcp-host.

## How it works

Endpoints (plain `node:http`, no framework):

- `GET /health`
- `POST /webhooks/telegram` — Telegram bot webhook updates
- `POST /webhooks/slack/:targetId` — Slack events / interactivity, per target

In the cluster, provider traffic reaches these routes through `webhook-proxy`
(`/webhooks/telegram` and `/webhooks/slack/:targetId` are forwarded to this
service — the path-forwarding rule lives in
`webhook-proxy/src/server.ts:181-184`; the proxy deployment is
`../deploy/base/webhook-ingress/webhook-proxy.yaml`).

Each request goes through: rate limit → 1 MB body cap → provider auth →
parse → normalize → dispatch. Normalized payloads become one of:

- **Decision** — Telegram `callback_query` data or Slack `block_actions` value,
  in verbose form `approve:<uuid>[:sandbox-recipes/<recipe>][:<channelAlias>]`
  (also `deny`/`approved`/`denied`/`reject`/`rejected`) or compact form
  `a:<22-char base64url uuid>:<recipe|~alias>[:<channelAlias>]` (`d:` = deny).
  The decision is POSTed to
  `{mcpHost}/v1/runtime/workflow-approvals/decide` with `x-clerum-edge-*`
  identity headers. Target base URLs come from configured targets
  (env/file) or are derived from the host ref
  (`sandbox-recipes/<recipe>` → `wf-<recipe>-mcp-host.sandbox-recipes.svc.cluster.local`,
  plain agent refs → `<hostRef>.mcp-host.svc.cluster.local`; service names
  over 63 chars fall back to a truncated stem plus an 8-char hash). Route
  hints are DNS routing only, never authorization.
- **Enrollment** — Telegram `/start <nonce>` or Slack `verify <6-digit code>`
  (or the `workflow_approval_link:<code>` button). Telegram enrollments are
  confirmed directly on the mcp-host
  (`/v1/runtime/workflow-approval-mediums/link-sessions/confirm`), resolving
  the CommunicationChannel ref via control-api first; Slack enrollments are
  handed off to the per-host channel-reader.
- **Slack message** — ordinary channel messages for the bot (mention-gated
  only when the target's `replyOnlyWhenMentioned` flag is set — default false —
  and DMs bypass the gate; inline `/approve <target>` / `/deny <target>`
  commands pass the mention gate)
  are handed off to `channel-reader-{host}:8099/internal/slack/handoff` with a
  bearer handoff token. Slack `url_verification` challenges are echoed.

Slack button decisions are acknowledged with `200` immediately and submitted in
the background; the original Slack message is then updated (or a threaded
failure reply sent) through control-api's slack-target proxy endpoints.

## Configuration

| Variable                                                     | Explanation                                                                                                                                                               | Default                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `WORKFLOW_APPROVAL_READER_PORT`                              | HTTP listen port.                                                                                                                                                         | `8098`                              |
| `WORKFLOW_APPROVAL_READER_ENABLED_MEDIA`                     | Comma-separated media; only `telegram` and `slack` are accepted.                                                                                                          | `telegram,slack`                    |
| `WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET`                   | Expected `x-telegram-bot-api-secret-token` value; unset means all Telegram requests 401.                                                                                  | —                                   |
| `WORKFLOW_APPROVAL_READER_MCP_HOST_TARGETS`                  | Semicolon list of `hostRef=baseUrl` workflow-runtime targets.                                                                                                             | —                                   |
| `WORKFLOW_APPROVAL_READER_MCP_HOST_TARGETS_FILE`             | File with the same `hostRef=baseUrl` format (mounted ConfigMap in-cluster).                                                                                               | —                                   |
| `WORKFLOW_APPROVAL_READER_MCP_HOST_BASE_URL` / `_REF`        | Primary mcp-host fallback target (`MCP_HOST_BASE_URL`/`MCP_HOST_REF` also read).                                                                                          | —                                   |
| `WORKFLOW_APPROVAL_READER_MCP_HOST_TIMEOUT_MS`               | Timeout for decision/enrollment calls to mcp-hosts.                                                                                                                       | `5000`                              |
| `WORKFLOW_APPROVAL_READER_CONTROL_API_BASE_URL`              | control-api base URL for Slack verification, can-approve, and channel-ref resolution.                                                                                     | — (disables control-api calls)      |
| `WORKFLOW_APPROVAL_READER_CONTROL_API_TOKEN`                 | Static bearer token for control-api internal endpoints.                                                                                                                   | —                                   |
| `WORKFLOW_APPROVAL_READER_CONTROL_API_TIMEOUT_MS`            | Timeout for control-api calls.                                                                                                                                            | `4000`                              |
| `WORKFLOW_APPROVAL_READER_RATE_LIMIT_WINDOW_MS`              | Fixed rate-limit window.                                                                                                                                                  | `60000`                             |
| `WORKFLOW_APPROVAL_READER_RATE_LIMIT_MAX_REQUESTS`           | Max requests per window per key.                                                                                                                                          | `120`                               |
| `WORKFLOW_APPROVAL_READER_CHANNEL_READER_URL_TEMPLATE`       | Per-host channel-reader URL template (`{host}` is replaced with the host ref).                                                                                            | `http://channel-reader-{host}:8099` |
| `WORKFLOW_APPROVAL_READER_CHANNEL_READER_HANDOFF_TOKEN`      | Bearer token for channel-reader handoff; unset disables Slack handoff (the internal 503 is only logged — handoff is fire-and-forget, so the Slack caller still gets 200). | —                                   |
| `WORKFLOW_APPROVAL_READER_CHANNEL_READER_HANDOFF_TIMEOUT_MS` | Timeout for channel-reader handoff calls.                                                                                                                                 | `5000`                              |
| `WORKFLOW_APPROVAL_READER_SLACK_SIGNING_SECRET`              | Loaded into config but currently unused — Slack verification is delegated to control-api.                                                                                 | —                                   |
| `WORKFLOW_APPROVAL_READER_MCP_HOST_MESSAGE_TIMEOUT_MS`       | Loaded into config but currently unused by the request path.                                                                                                              | `120000`                            |

## Ports

- `8098` — HTTP: `/health` probes and `/webhooks/*`. Only port exposed.

## Security

- **Telegram auth**: constant-time comparison (`crypto.timingSafeEqual`) of the
  `x-telegram-bot-api-secret-token` header against the configured secret.
- **Slack auth**: per-target signature verification is delegated to control-api
  (timestamp, signature, and raw body are sent to an internal verify endpoint);
  the verified target's workspace ID is then cross-checked against the payload
  `team_id` — mismatch returns `403 slack_workspace_mismatch`.
- **Fail-safe can-approve pre-check**: decisions carrying a `channelAlias`
  trigger a control-api `can-approve` check before forwarding; `false` or
  any control-api error means the decision is **not** forwarded (`403`). The
  check is skipped when control-api is not configured — the authoritative
  binding is enforced again by control-api at transmission time.
- **Abuse controls**: fixed-window in-memory rate limit (`429`, keyed per Slack
  target or per peer IP), 1 MB body cap (`413`), and a 10-minute provider-event
  dedupe — applied to Slack enrollment events and Slack messages only; decision
  callbacks (Telegram `callback_query`, Slack `block_actions`) are not deduped
  by the reader. All three are in-memory and best-effort: they reset on restart, so
  downstream approval handling must stay idempotent and authorization-backed.
- **Network**: NetworkPolicy restricts ingress on 8098 to `webhook-proxy` pods
  and the `ingress-nginx` namespace; dedicated egress policies cover mcp-host,
  control-api, and channel-reader.
- **Supply chain**: zero runtime npm dependencies (Node >= 24 stdlib only);
  runs as non-root with a read-only root filesystem and all capabilities
  dropped.

## Testing

```bash
npm install
npm test   # vitest — 64 test cases across 8 files
```

Covers provider auth, decision/enrollment/message normalization, rate
limiting, dedupe, and the control-api / mcp-host / channel-reader clients.

## Deployment

Manifests live in `../deploy/base/channels/workflow-approval-request-reader/`
(Deployment, Service, ConfigMap, ServiceAccount) with NetworkPolicies in
`../deploy/base/channels/networkpolicies/`. Secrets (Telegram webhook secret,
control-api token, channel-reader handoff token) come from the
`workflow-approval-request-reader-credentials` Secret.
