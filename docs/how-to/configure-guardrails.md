# How to: add guardrails to an agent

Guardrails are an **opt-in** policy block on a Host (`spec.guardrails`). A
Host without one behaves exactly as before. No guardrails block and no
`LlmHook` ship in `deploy/base` or the minikube overlays. The base only
creates the `llm-hooks` namespace, its RBAC, and a default-deny
NetworkPolicy, so there is no flag to flip: you turn guardrails on by
writing the block.

Guardrails are a policy layer inside mcp-host. They are **not a sandbox**.
Argument predicates are lexical, so path and URL checks are not TOCTOU-safe.
A guardrail `allow` never bypasses the approval gate, the input validators,
or workload isolation.

## Mental model

There are two lanes, and both use the same `allow` / `ask` / `deny`
decisions:

| Lane          | What runs                                                                                                               | Where it acts                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Tool lane** | `rules[]`, installed hooks at `preToolUse` / `postToolUse`, a doom-loop check                                           | Before a tool call (decide), after it (redact the result) |
| **LLM lane**  | Built-ins (`prompt-shaping`, `token-trim`), then installed hooks at `preCall`, `moderate`, `postCallSuccess`, `onError` | Around the main model call                                |

How a tool call is decided:

1. Every rule that matches the call contributes its action, and so does
   every `preToolUse` hook that returns a decision.
2. **The strictest contribution wins:** `deny` > `ask` > `allow`. The order
   of the rules does **not** matter. A broad `allow` cannot override a
   narrower `deny`.
3. If the Host has at least one rule and **nothing matched**, the result is
   `ask` (reason `unmatched_ask`). If the Host has no rules, the result is
   `no_decision` and the call follows the normal path.
4. The result is applied:
   - `deny` returns `Blocked by guardrail policy (<reason>)` to the model.
   - `ask` suspends the call for approval.
   - `allow` and `no_decision` go on to the normal [approval gate](configure-approvals.md).

Because of step 3, adding a single `deny` rule turns **every other** tool
call into an `ask`. Pair specific rules with a catch-all `allow` per
provenance (see the example below).

### How `ask` interacts with approvals

- In an **interactive** run, a guardrail `ask` creates a pending approval
  scoped to that exact invocation. Its description reads
  `Guardrail requires approval (<reason>)`. You approve it on the usual
  surfaces. Once it is approved, the call runs without a second prompt from
  `spec.approval`.
- Tasks started by a person's message (Desktop App chat or a messaging
  channel; task source `channel`) are interactive. `cron` and `internal`
  tasks are **unattended**. In an unattended run an `ask` becomes
  a deny ("approval required but no approver is available"), so the task
  does not hang.
- `allow` does not skip approvals. MCP tool calls still go through the
  approval gate, which `spec.approval` does not configure. Native tools
  still follow their own approval default (for example `shell_exec` and
  `http_request` ask) or the per-tool override in `spec.approval.tools`.
  See [Configure approvals](configure-approvals.md).

## Option A — mcp-host dev mode

Set `CLERUM_GUARDRAILS_CONFIG` to the JSON form of the `spec.guardrails`
block. mcp-host uses it only when no Host CR supplies one. For dev and E2E,
you can also list hooks inline as `hookDescriptors` to point at a local hook
server without the reconciler.

## Option B — Host CRD

Apply the current `charts/clerum-crds` first. The API server **silently
prunes** fields that an older CRD does not know, so a `guardrails` block
written against a stale CRD simply disappears.

```yaml
apiVersion: clerum.io/v1alpha1
kind: Host
metadata:
  name: chatllm
  namespace: mcp-host
spec:
  # ...existing fields...
  guardrails:
    rules:
      # Catch-alls so unmatched calls don't fall to `ask`.
      - id: allow-native
        action: allow
        match: { tool: { provenance: native } }
      - id: allow-mcp
        action: allow
        match: { tool: { provenance: mcp } }
      # Strictest wins: this deny beats allow-native.
      # Defence in depth only: http_request already refuses private and
      # metadata IPs. URL predicates are lexical, and URLs with credentials
      # never match.
      - id: no-metadata-endpoint
        action: deny
        reasonCode: metadata_blocked
        match:
          tool: { provenance: native, name: http_request }
          arguments:
            - { type: url, pointer: /url, op: host_in, value: ['169.254.169.254'] }
      - id: ask-github-writes
        action: ask
        match: { tool: { provenance: mcp, server: github, name: '*create*' } }
    builtins:
      - type: token-trim
        order: 10
        config: { maxInputTokens: 60000 }
    capabilityCeiling: [may_deny, may_substitute_result]
    hooks:
      postCallSuccess:
        - id: pii-redactor
          digest: sha256:<digest>
```

**Rule fields.** Each rule needs:

- `id`: unique within the Host.
- `action`: `allow`, `ask` or `deny`.
- `match.tool.provenance`: `native` or `mcp`. Provenance comes from the tool
  registry, never from the tool's name.

`server` and `name` are optional. They support only `*` and `?` wildcards,
anchored to the whole value. If you omit them, the rule matches every tool of
that provenance.

- **MCP tool names carry the server prefix.** `name` is matched against the
  registered name, `<server>__<tool>` (double underscore), not the bare tool
  name. A tool `create_issue` on the `github` server is `github__create_issue`,
  so `name: create_issue` never matches; use `name: github__create_issue` or a
  wildcard such as `'*create*'`. Use `server` to scope by server.
- **`clerum__*` tools are native.** The platform's own tools (for example
  `clerum__gfs_read`, `clerum__generate_pdf`, `clerum__session_search`) have
  `__` in their names but are registered as native tools. Match them with
  `provenance: native`; a `provenance: mcp` rule never matches them. Keep a
  catch-all native `allow` rather than listing native tools one by one. An
  unlisted platform tool falls to `unmatched_ask`; for example, a GFS file
  attached in chat is then left unprepared, with no prompt shown.

A rule's `arguments[]` predicates must **all** match. Each predicate has a
`type`, a JSON Pointer into the arguments, an `op` and a `value`:

| `type`    | `op` values                                     | Notes                                                                                       |
| --------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `path`    | `equals`, `under`, `outside`                    | Lexical normalisation; no symlink resolution                                                |
| `url`     | `scheme_in`, `host_in`, `port_in`, `path_under` | URLs with credentials never match                                                           |
| `command` | `executable_is`, `argv_prefix`                  | Argument must be `[exe, ...args]` or `{executable, args}`; a shell **string never matches** |
| `json`    | `exists`, `equals`, `one_of`, `contains`        | Canonical key order                                                                         |

The CRD does not validate rule shape. mcp-host compiles the rules when a task
starts, and a malformed set (missing provenance, duplicate id, invalid action
or predicate type, bad pointer) makes the task fail rather than run with part
of the rules. An unknown `op` is not caught at start: it throws when a call
matching the rule's tool filter is evaluated, and the task fails then.

**Built-ins** run in-process on the main model lane only, sorted by `order`
(default 100). For each item, mcp-host reads only `type`, `order` and
`config`.

- `prompt-shaping` forces `temperature`, `maxTokens` and `toolChoice`.
- `token-trim` reuses the pre-prune passes. It accepts `maxInputTokens`,
  `protectedTailTurns`, `summaryThresholdTokens`, `maxArgsBytes` and per-pass
  toggles. When `maxInputTokens` is set and the request is already under it,
  the request is left unchanged.

**Hooks** reference installed [LlmHook](../crds/llmhook.md) CRs as `{id,
digest}`. The full field list is in [Host CRD → Guardrails](../crds/host.md#guardrails).

mcp-host picks up Host and LlmHook changes live; you do not need to restart
the pod.

## Option C — the Control UI

### Install a hook from the Marketplace

1. In the sidebar, open **Installed Guardrails** (`/guardrails`). The page
   lists every `LlmHook` with its lifecycle, order, fail mode and status.
2. Click **Install Guardrail**. This opens the org Marketplace entries,
   filtered to guardrail hooks (`/marketplace/org/entries?type=llm-hook`).
   Pick an entry and choose **Install**.
3. In the install form (**Configure** → **Install**):
   - **Agent**: the Host to bind to. It defaults to the first agent in the
     list, so check it.
   - **Credentials**: shown only if the hook declares a credential schema.
   - **Advanced details**: the capabilities to grant, **Order** (default
     100), and **Fail mode**. Ticking **May deny** forces fail closed.
4. **Install** calls `POST /admin/registry/install-hook`. That call:
   - checks the entry: it must be org-scoped, and its admission rules are
     validated;
   - checks the agent: the hook's trust level must meet the agent's floor,
     and the capabilities you selected must fall within the agent's ceiling;
   - for image hooks, requires a digest-pinned image and checks the image
     allowlist when enforcement is on;
   - creates the `LlmHook` in `llm-hooks`, stamped with a platform-assigned
     `clerum.io/trust-level` annotation;
   - adds a reference to the agent under **every** lifecycle point the hook
     declares. For image hooks, the reference includes the image digest.

   If the agent update fails, the install rolls back.

**Before you install, set `capabilityCeiling` on the Host.** A missing
ceiling counts as the empty set, so no capability can be granted. The UI has
no editor for the ceiling.

**Trust levels** (`low` < `mid` < `high`) come from the registry. They are
taken at face value only for curated orgs: your cluster's own org,
`@clerum`/`@evenfire`, and any org listed in `CONTROL_API_CURATED_HOOK_ORGS`.
Every other org is capped at `CONTROL_API_DEFAULT_HOOK_TRUST_CAP` (default
`mid`).

### See and remove hooks on an agent

Open **Agents** → the agent → **Advanced** → **Hooks**. The table lists each
`{hook, phase}` reference. Row actions are **View details** and
**Remove from \<phase\>**. Removing a reference stops the hook at that
phase but leaves it installed. To
remove it from the cluster, uninstall it on **Installed Guardrails**. That
strips the reference from every Host first, then deletes the CR. **Add
hook** goes to the same Marketplace list.

The UI edits hook references only. It has no editor for rules, built-ins,
trust floor, ceiling or limits, and it cannot attach an already-installed
hook to a second agent. Use the CRD (Option B) for those. The UI preserves
the fields it does not edit when it saves.

## Hook behaviour you should know

- **Capabilities are enforced on the response.** If a hook returns a deny
  without `may_deny`, the deny is downgraded to no decision. A rewrite
  without `may_rewrite` is dropped, and so is a substitute without
  `may_substitute_result`. `may_add_context` has no effect today: mcp-host does not apply context that a hook returns, whether or not the capability is granted.
  Installed hooks can never change the system prompt.
- **`failMode` only bites with the matching capability.** If a hook is
  unavailable (timeout, 5xx, a malformed or oversized reply, or an SSRF
  refusal):
  - a `failMode: closed` hook with `may_deny` contributes a deny
    (`hook_unavailable`);
  - a closed `postToolUse` redactor with `may_rewrite` withholds the tool
    result;
  - a closed `postCallSuccess` hook with `may_substitute_result` withholds
    the model output;
  - in every other case the hook contributes nothing.

  The CRD defaults to `closed`. The install route defaults to `open` unless
  `may_deny` is requested; the form preselects the hook author's suggested
  fail mode (or `open`), and **May deny** forces `closed`.

- **Timeouts.** The Host's `limits.maxHookTimeoutMs` (default 5000 ms) is
  the transport timeout for each hook call on both lanes. Every hook call
  also has a fixed 15000 ms hard deadline, so a value above 15000 has no
  effect: the call reports unavailable after 15 seconds.
  mcp-host does not read `LlmHook.spec.timeoutMs`.
- **Circuit breaker.** `onUnavailable.mode: breaker` (threshold 5, cooldown
  30000 ms by default) short-circuits a down hook without dialing it. It
  applies on both lanes, only to hooks **without** `may_deny`, and a hook
  has one breaker state shared by both lanes. A deny-capable hook is always
  dialed.
- **Digest binding.** For image hooks whose Host reference pins a `digest`,
  mcp-host compares it with `LlmHook.status.observedDigest` (once that is
  set). On a mismatch it quarantines the hook on both lanes: every call
  reports unavailable without dialing, so the fail-mode rules above apply.
  The same quarantine applies to a
  co-located hook that lost a `DuplicatePath` collision. Upgrade with
  `POST /admin/registry/upgrade-hook`, which bumps the CR and every Host's
  digest together.
- **The Host phase key decides where a hook runs.** A hook runs only at the
  points that are both declared in its `lifecyclePoints` and referenced on
  the Host. A Host phase the hook does not declare is ignored. Upgrade keeps
  each Host's phases: it drops phases the new version no longer declares and
  adds none the Host did not already reference, including newly declared
  ones. If no phase survives, the hook is re-referenced at all of its new
  points.

## Try the reference hook

[`hooks/reference-guardrail-hook/`](../../hooks/reference-guardrail-hook/) is
a zero-dependency Node server. It implements the **LLM-lane** points only:

- `pre_call` rejects jailbreak phrases;
- `moderate` returns 422 on disallowed content;
- `post_call` redacts card, SSN and email patterns;
- `on_error` returns a text fallback.

It has no tool-lane endpoints. To try it:

```bash
docker build -t reference-guardrail-hook:dev hooks/reference-guardrail-hook
minikube -p <profile> image load reference-guardrail-hook:dev
kubectl apply -f hooks/reference-guardrail-hook/deploy.yaml
```

Then point an `LlmHook` at the Service and reference it from a Host. Use
`kubectl`, because control-api only allows hooks to be created through
`install-hook`:

```yaml
apiVersion: clerum.io/v1alpha1
kind: LlmHook
metadata: { name: reference-hook, namespace: llm-hooks }
spec:
  target:
    service: { name: reference-guardrail-hook, namespace: llm-hooks, port: 8080 }
  lifecyclePoints: [preCall, moderate, postCallSuccess]
  capabilities: [may_deny, may_substitute_result]
  failMode: closed
---
# On the Host (service targets have no digest to pin):
spec:
  guardrails:
    capabilityCeiling: [may_deny, may_substitute_result]
    hooks:
      preCall: [{ id: reference-hook }]
```

host-context-controller marks a service-target hook `Ready=True` with reason
`NoWorkload`. It also creates `llmhook-svc-reference-hook`, which admits
ingress from the referencing Hosts only. A hand-applied CR skips the
install-time trust-floor and ceiling checks (see Limits).

## Verify

1. Run `kubectl get llmhooks -n llm-hooks` and check that the hook is Ready
   and that its digest matches the Host reference.
2. Send a prompt the hook should block. You should get a canned refusal
   (for example _"I can't comply with that request."_), not the model's
   answer.
3. For rules, trigger a matching tool call and look for the `Blocked by
guardrail policy` result or a pending approval. The
   `clerum_mcp_host_guardrail_decisions_total` metric counts decisions by
   `lane`, `decision`, `source`, `execution_mode`, `phase`, `outcome` and
   `reason_code`.

## Limits

- **Install-time checks only.** `minInstalledHookTrustLevel` and
  `capabilityCeiling` are checked by control-api at install and upgrade.
  mcp-host does not re-check them at runtime, so a reference added by
  editing the Host bypasses both.
- **No runtime reader.** `approvalPolicies` and `limits.maxHooksPerPhase`
  are accepted by the CRD, but nothing reads them today. Approver routing
  stays in `spec.approval`.
- **Response size caps.** `limits.maxHookOutputBytes` caps LLM-lane hook
  responses. The CRD default (65536) applies only when a `limits` object is
  present; otherwise mcp-host uses 1 MiB, and `preCall` rewrites get 5 MiB.
  Tool-lane hooks are not capped by this field.
- **Doom-loop guard.** It is active whenever tool-lane rules or hooks exist:
  the third consecutive identical call is denied (`repeated_identical_call`).
  It is a runaway guard, not a security control, because alternating calls
  evade it.
- **Scope.** The aux/compaction model lane runs no guardrails.

## Troubleshooting

| Symptom                                                                           | Cause / fix                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec.guardrails` vanishes after apply                                            | The CRD is older than the field and pruned it. Apply `charts/clerum-crds` first, then re-apply the Host.                                                                                                                        |
| Every tool call now asks for approval                                             | Rules exist and nothing matched (`unmatched_ask`). Add catch-all `allow` rules per provenance.                                                                                                                                  |
| Cron or workflow tasks fail with "approval required but no approver is available" | A guardrail `ask` in an unattended run. Add a rule that resolves the call to `allow` or `deny`.                                                                                                                                 |
| Tasks fail right after you edit rules                                             | The rule set is malformed and rejected as a whole. Check mcp-host logs for the rule id.                                                                                                                                         |
| Refusal "a required safety check is unavailable"                                  | A `may_deny` hook with `failMode: closed` is unreachable, timing out, or quarantined. Check the hook's pod and the Host `digest` against `status.observedDigest`.                                                               |
| mcp-host logs `digest mismatch ... quarantining`                                  | The hook image changed without the Host pin. Use upgrade-hook, or update the `digest` to `status.observedDigest`.                                                                                                               |
| Install: `capability_exceeds_ceiling`, or no capability can be ticked             | The Host has no `capabilityCeiling`, or the ceiling is too narrow. Set it on the Host.                                                                                                                                          |
| Install: `hook_below_trust_floor`                                                 | The hook's resolved trust is below `minInstalledHookTrustLevel`.                                                                                                                                                                |
| Install: `content_egress_requires_high_trust`                                     | The hook sees content and has egress or a remote target, so it needs `high` trust, which non-curated orgs never reach under the default `mid` cap. Add the org to `CONTROL_API_CURATED_HOOK_ORGS` or use a hook without egress. |
| Install: `content_access_conflict`                                                | The entry declares `contentAccess: metadata` on a content-bearing point. The publisher must fix `hook_meta` and republish.                                                                                                      |
| Install: `hook_requires_org_scope` / `image_ref_not_digest_pinned`                | Only org-owned entries can be installed, and an image-target hook must use an `@sha256:` image ref.                                                                                                                             |
| Hook installed, but it never runs                                                 | Check that a Host references the hook's id, and that the CR is not `Ready=False/DuplicatePath`. A hook that returns a deny without `may_deny` is ignored.                                                                       |

## Related

- [LlmHook CRD](../crds/llmhook.md)
- [Host CRD → Guardrails](../crds/host.md#guardrails)
- [Configure approvals](configure-approvals.md)
- [Control UI](../surfaces/control-ui.md)
- [Claims guardrails](../meta/claims-guardrails.md)
