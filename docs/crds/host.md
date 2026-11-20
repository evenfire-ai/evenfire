# Host CRD Reference

**API Group:** `clerum.io`
**Version:** `v1alpha1`
**Scope:** Namespaced
**Watched by:** mcp-host

## Purpose

Host is the central entity that binds an LLM model provider to a context (MCP server allowlist),
a Kubernetes Secret containing API keys, and one or more communication channels. Each Host
represents a single LLM agent instance (an "agent" in Control UI and the Desktop App).

## Spec Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `spec.host` | string | yes | Display name for the agent (free text, spaces and capitals allowed). The immutable identifier is `metadata.name`. |
| `spec.contextRef` | string | yes | Reference to the Context CRD name that defines which MCP servers this host can access. Control UI creates a private Context per agent automatically; you only manage Contexts directly when working with CRDs. |
| `spec.secretRef` | string | conditional | Name of the Kubernetes Secret holding static LLM API keys, one data key per provider slot (e.g. `openai-api-key`, `claude-api-key`, `groq-api-key`; see [LLM providers](../llm-providers/README.md)). Required whenever the primary or a fallback uses a static-credential provider; optional only when every target is the same subscription provider. |
| `spec.channels` | string[] | no | List of CommunicationChannel CRD names this host interacts with. |
| `spec.model` | object | no | LLM model configuration. |
| `spec.model.provider` | string | no | One of the 24 provider ids in [`packages/llm-providers`](../../packages/llm-providers/index.cjs): `openai`, `claude`, `zai`, `bailian`, `vertex`, `bedrock`, `openrouter`, `gemini`, `deepseek`, `groq`, `together`, `fireworks`, `mistral`, `xai`, `cerebras`, `deepinfra`, `perplexity`, `moonshot`, `nebius`, `novita`, `minimax`, `azure`, `codex-subscription`, `grok-subscription`. |
| `spec.model.name` | string | no | Model name (e.g. `gpt-5.4-mini`, `claude-opus-4-7`, `glm-5.1`). Must be enabled in the operator model allowlist. |
| `spec.model.connectionRef` | string | no | Named subscription connection this Host is assigned to (subscription providers only). |
| `spec.allowedModels[]` | object[] | no | Up to 32 `{provider, model}` pairs users may switch between per session. Each pair must exist in the global allowlist. |
| `spec.llmPolicy` | object | no | Opt-in provider fallback. `fallbacks[]` (1–8 ordered `{provider, model, credentialSlot?}`), `triggerOn[]` (subset of `insufficient_quota`, `auth`, `provider_unavailable`, `rate_limited`; default all), `cooldownSeconds` (default 300) before the primary is retried. A Host may use at most one subscription provider across primary and fallbacks. |
| `spec.workflowControl.scopes` | string[] | no | Workflow broker scopes this Host may receive in its mcp-host-control JWT. Valid values: `workflow:list`, `workflow:read`, `workflow:trigger`, `workflow:approval:resolve`, `workflow:approval:decide`. `workflow_status` and `workflow_health` are covered by `workflow:read`; there is no native `workflow_read` tool. `workflow:approval:resolve` is required for provider identity resolution through this first-party Host; `workflow:approval:decide` is required when a bound channel-reader relays provider-originated workflow approval decisions. |
| `spec.approval` | object | no | Tool approval configuration -- controls who can approve tool executions, the approval-mode ceiling, and which channels may change the mode. |
| `spec.approval.defaultPolicy` | string | no | Who can approve tool calls. One of: `cli_only` (HTTP endpoints only), `channel_users` (any authorized channel user), `designated_approvers` (only users in approvers list). |
| `spec.approval.modeCeiling` | string | no | Highest interactive approval mode sessions on this Host may run: `manual`, `auto`, or `allow_all`. Absent means `manual`. Read from this CR only. See [Approval mode ceiling](#approval-mode-ceiling). |
| `spec.approval.shellClassifierModel` | string | no | Model the shell classifier calls when this Host has an OpenAI credential. Absent means `gpt-5.5`. A model the classifier does not allow shows the shell card. With no OpenAI credential, auto keeps the model serving the turn. |
| `spec.approval.channels` | object | no | Per-channel-type approval settings for `telegram`, `email`, `slack`, and `teams`. |
| `spec.approval.channels.telegram` | object | no | Telegram approval config. |
| `spec.approval.channels.telegram.enabled` | boolean | no | Whether Telegram users can approve. |
| `spec.approval.channels.telegram.approvers` | string[] | no | List of Telegram user IDs allowed to approve. |
| `spec.approval.channels.telegram.allowModeChange` | boolean | no | Default `true`. When `true` or absent, a Telegram session may store `auto` or `allow_all`, up to `modeCeiling`. Only `false` caps that channel at `manual`. |
| `spec.approval.channels.email` | object | no | Email approval config. |
| `spec.approval.channels.email.enabled` | boolean | no | Whether email users can approve. |
| `spec.approval.channels.email.approvers` | string[] | no | List of email addresses allowed to approve. |
| `spec.approval.channels.email.allowModeChange` | boolean | no | Default `false`. Only when `true` may an email session store `auto` or `allow_all`, up to `modeCeiling`. Absent or `false` caps email at `manual`. Email identity is the From address, which a sender can forge. |
| `spec.approval.channels.slack` | object | no | Slack approval config. |
| `spec.approval.channels.slack.enabled` | boolean | no | Whether Slack users can approve. |
| `spec.approval.channels.slack.approvers` | string[] | no | List of Slack user IDs allowed to approve. |
| `spec.approval.channels.slack.allowModeChange` | boolean | no | Default `true`. When `true` or absent, a Slack session may store `auto` or `allow_all`, up to `modeCeiling`. Only `false` caps that channel at `manual`. |
| `spec.approval.channels.teams` | object | no | Microsoft Teams approval config. |
| `spec.approval.channels.teams.enabled` | boolean | no | Whether Teams users can approve. |
| `spec.approval.channels.teams.approvers` | string[] | no | List of Teams user IDs allowed to approve. |
| `spec.approval.channels.teams.allowModeChange` | boolean | no | Default `true`. When `true` or absent, a Teams session may store `auto` or `allow_all`, up to `modeCeiling`. Only `false` caps that channel at `manual`. |
| `spec.approval.tools` | object | no | Per-tool approval override map for native mcp-host tools. Map of tool name (e.g. `http_request`, `shell_exec`) to boolean: `true` forces approval, `false` skips approval. Absent entries fall through to each tool's built-in default. An explicit `shell_exec: true` keeps a card on every shell call in auto. MCP tools (named `serverName__toolName`) are NOT covered. See `mcp-host/README.md#per-tool-approval-overrides` for the v1 tool list and warning behavior. |
| `spec.desktop` | object | no | Desktop environment configuration. |
| `spec.desktop.browser` | boolean | no | Enable Playwright browser tools (`browser_open`, `browser_screenshot`, etc.). |
| `spec.desktop.x11` | boolean | no | Enable X11 desktop tools (`desktop_screenshot`, `desktop_click`, `desktop_type`, etc.). |
| `spec.lifecycle.stateless` | boolean | no | Default `false`. Enables the stateless lifecycle: session state is persisted to the workspace volume and the controller may scale the agent to zero while idle (`status.lifecycle.state: suspended`). Rejected at reconcile (condition `StatelessEnableRejected`) for Hosts with channels or a desktop. |
| `spec.personalization` | object | no | Identity files (admin-managed, read-only to the agent). |
| `spec.personalization.enabled` | boolean | no | Whether mcp-host should reconcile identity files from this block. |
| `spec.personalization.identity` | string | no | Content of `IDENTITY.md` (system-prompt section "## Identity"). |
| `spec.personalization.soul` | string | no | Content of `SOUL.md` (system-prompt section "## Core Values"). |
| `spec.personalization.agents` | string | no | Content of `AGENTS.md` (system-prompt section "## Agent Instructions"). |
| `spec.personalization.user` | string | no | Content of `USER.md` (system-prompt section "## User Context"). |
| `spec.guardrails` | object | no | Opt-in guardrail policy. A Host without it runs no rules or hooks. See [Guardrails](#guardrails). |

### Guardrails

| Field | Description |
|-------|-------------|
| `guardrails.rules[]` | Tool-lane rules `{id, action: allow\|ask\|deny, reasonCode, match: {tool, arguments[]}}`. Every matching rule contributes and the strictest decision wins; array order is not precedence. Once any rule exists, a call that matches none resolves to `ask`. |
| `guardrails.hooks.<phase>[]` | Installed [LlmHook](llmhook.md) references `{id, digest}` per phase: `preToolUse`, `postToolUse`, `preCall`, `moderate`, `postCallSuccess`, `onError`. A referenced hook runs only at the phases it is referenced under that its own `lifecyclePoints` also declare. |
| `guardrails.builtins[]` | First-party hooks compiled into mcp-host (e.g. `prompt-shaping`, `token-trim`). |
| `guardrails.minInstalledHookTrustLevel` | `low` \| `mid` \| `high`: minimum trust level for hooks installed onto this Host. Checked by control-api when a hook is installed or upgraded, not at runtime. |
| `guardrails.capabilityCeiling[]` | Upper bound on the capabilities an install may grant: `may_deny`, `may_rewrite`, `may_substitute_result`, `may_add_context`. Checked at install/upgrade, not at runtime, so a hand-edited LlmHook is not re-validated against it. |
| `guardrails.approvalPolicies[]` | Accepted by the schema (`cli_only`, `channel_users`, `designated_approvers`) but not read by mcp-host today; `ask` decisions use `spec.approval`, or mcp-host's `CLERUM_APPROVAL_CONFIG` when `spec.approval` is unset. |
| `guardrails.limits` | `maxRules` (100) and `maxHookTimeoutMs` (5000, the transport timeout for each hook call on both lanes) are enforced; every hook call also has a fixed 15000 ms hard deadline, so a larger value has no effect. `maxHookOutputBytes` (65536 when a `limits` object is present; otherwise 1 MiB) caps `moderate`, `postCallSuccess` and `onError` hook responses. It does not apply to `preCall` (always 5 MiB) or to tool-lane hooks (1 MiB). `maxHooksPerPhase` is accepted but not enforced. |

Apply the CRD before any component writes `spec.guardrails`: the API server
silently prunes fields an older CRD does not know.

## Status Fields

| Field | Description |
|-------|-------------|
| `status.lifecycle` | Stateless lifecycle state: `state` (`active` \| `draining` \| `suspended`), `wakeHandledGeneration`, `reason`. |
| `status.conditions[]` | Standard conditions (e.g. `StatelessEnableRejected`). |

## Additional Printer Columns

`kubectl get hosts` displays: Host, Context, Secret, Provider.

## Example

```yaml
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: chatllm
spec:
  host: chatLLM
  contextRef: context1
  secretRef: chatllm-api-keys
  model:
    provider: claude
    name: claude-opus-4-7
  workflowControl:
    scopes:
      - workflow:list
      - workflow:read
      - workflow:trigger
      - workflow:approval:resolve
      - workflow:approval:decide
  channels:
    - all-channels
  approval:
    defaultPolicy: designated_approvers
    # Highest mode sessions may run. Absent means manual. Read from this CR only.
    modeCeiling: manual
    channels:
      telegram:
        enabled: true
        approvers:
          - "123456789"
        allowModeChange: false
    tools:
      http_request: false   # skip approval — relies on CLERUM_HTTP_ALLOWLIST as the gate
      shell_exec: true      # explicit: in auto this keeps a card on every shell call. Remove it if auto should judge shell.
```

The referenced Secret must exist in the same namespace:

```bash
kubectl create secret generic chatllm-api-keys \
  --from-literal=openai-api-key=sk-xxx \
  --from-literal=claude-api-key=sk-ant-xxx \
  --from-literal=zai-api-key=zai-xxx \
  --from-literal=bailian-api-key=sk-xxx
```

## Approval mode ceiling

`spec.approval.modeCeiling` and each channel's `allowModeChange` are read from this Host CR only. The same fields in mcp-host's `CLERUM_APPROVAL_CONFIG` are ignored: that variable is parsed once at startup, so it cannot act as a live kill switch. The exception is dev mode (`CLERUM_DEV_MODE`), which has no Host watch and reads both fields from `CLERUM_APPROVAL_CONFIG`.

An absent ceiling, a Host with no `spec.approval`, or any other value means `manual`. A Telegram, Slack, or Microsoft Teams session may rise above manual unless that channel's `allowModeChange` is `false`; the switch defaults to on. An email session may rise above manual only when `email.allowModeChange` is `true`; the switch defaults to off, because the From address can be forged. A malformed value (a non-object `channels` or channel block, or a non-boolean `allowModeChange`) caps that channel at manual, and mcp-host logs `approval_config_invalid` naming the field. Desktop is not capped by a channel switch. See [Configure approvals](../how-to/configure-approvals.md).

A Host whose approval policy comes only from the ConfigMap has ceiling `manual` and channel cap `manual`. mcp-host uses `spec.approval` or the ConfigMap policy as one whole object, so adding `spec.approval` replaces that policy. Copy `defaultPolicy`, `channels`, and `tools` into the CR in the same edit that sets the ceiling.

An explicit `shell_exec: true`, including the example above, keeps a card on every `shell_exec` in auto, with no classifier and no shell memory. Remove that line if auto should judge shell. Allow-all runs it with no card. A guardrail `ask` (an explicit `ask` rule, or the `unmatched_ask` default of a Host with guardrail rules) keeps its card in every interactive mode, allow-all included.

`spec.approval.shellClassifierModel` is the model that judges shell when the Host has an OpenAI credential. Absent means `gpt-5.5`. An older CRD prunes the field, which is the same as absent. With no OpenAI credential, auto keeps the model serving the turn. See [Configure approvals](../how-to/configure-approvals.md#classifier-coverage).

Apply this CRD before any component writes `modeCeiling` or `allowModeChange`. Until it is applied, the API server prunes the new fields and the ceiling stays manual. An `allowModeChange: false` written before the CRD is lost; write it again after the CRD is applied, before raising the ceiling.

## Related

- [Context CRD](context.md) -- referenced via `spec.contextRef`
- [CommunicationChannel CRD](communicationchannel.md) -- referenced via `spec.channels[]`
- [CRD Index](README.md)
- [Example](../../charts/clerum-crds/examples/host-chatllm.yaml)
