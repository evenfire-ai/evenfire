# Comparison · Guardrails spec vs LLM-hooks spec — where they agree & what each emphasizes

|  |  |
|---|---|
| **Colleague's doc** | *(DRAFT) MCP Host Guardrails — Permission Rules, Hooks & Admin Policy Specification* (draft target contract; not implemented) |
| **Our doc** | [`llm-hooks-spec.md`](./llm-hooks-spec.md) — LLM pre/post-call hooks + marketplace |
| **This doc** | where the two align (§2), what each emphasizes (§3–4), and where they genuinely disagree (§5) |

---

## 1 · They govern different lanes (so "agree" = shared principles, not same scope)

Before the comparison: the two specs sit on **different lanes** and both are needed.

- **Colleague's — the tool lane.** Guardrails on *tool execution* (native + MCP): `PreToolUse`/
  `PostToolUse` hooks, host permission rules (`allow`/`ask`/`deny`), Context admin policy, approvals.
- **Ours — the LLM lane.** Hooks on *the model completion call*: `pre_call`/`moderation`/`post_call`/
  `on_error` for guardrail/PII/prompt-shaping/token-trim, plus a marketplace for remote hooks.

A request runs **our lane** (mutate/moderate the model call → the model emits a tool call) then **his
lane** (authorize/execute that tool call). They **stack**; neither replaces the other. So the
agreements below are shared *principles*, applied to two different boundaries.

---

## 2 · Where you agree (shared design principles)

Strong alignment — both specs independently landed on the same guardrail philosophy:

| Shared principle | Colleague (Guardrails) | Ours (LLM-hooks) |
|---|---|---|
| **One mandatory mediation boundary; fail-closed** | G1 universal mediation; decision-making hooks default closed | `HookedLlmPort` single funnel; fail-closed default for guardrail/PII |
| **Hooks never hold credentials/secrets** | G10 + §9.2: no LLM keys, K8s creds, or secret env in the hook | §6: hooks never receive the LLM provider credential |
| **Hook trust via allowlist + content digest** | G10: preinstalled, admin-allowlisted, digest-verified | image-allowlist + sha256 bundle digest + `trust_level` |
| **Admin/policy delivered by HCC as an atomic artifact; Host can't weaken it** | G4/G13: HCC materializes a read-only, digest-checked policy artifact | HCC reconciles `LlmHook` CRs; `global`/`context` scope, mcp-host only reads |
| **Pre = mutate/reject; Post = redact/transform; Post can't undo side effects** | §9.3/§9.4 | `pre_call` continue/reject; `post_call_success` transforms the response |
| **Rewrite safety: a rewrite replaces the whole input and is revalidated** | G7 | `pre_call` `patch` applied by mcp-host, request re-validated before dispatch |
| **Fire/execute at-most-once, safe across retries** | G11/G12 (at-most-once execution; Post once) | `HookedLlmPort` fires once per logical request, **above** failover |
| **Bounded, redacted observability** | §13/G15: fixed-enum metric labels; audit uses digests, not raw args | §6: audit-logged; telemetry on raw counts; redacted content projection |
| **No-config compatibility (unconfigured = current behavior)** | G8 | PR1 lands an empty chain — pass-through, zero behavior change |
| **Bounded hook execution (timeout + failure mode)** | `timeoutMs` + `failureMode` | per-hook `timeoutMs` + `failMode` + `onUnavailable` breaker |
| **Evaluate the real resolved identity, not a guessed one** | G2 resolved identity; provenance from the registry | `ctx` carries the real model/provider + `usageContext` |

Net: on **trust model primitives** (digests, allowlists, no-secrets, HCC-delivered admin artifact,
bounded audit) and **hook lifecycle** (pre-mutate/reject, post-transform, at-most-once, revalidation,
no-config safety) you are aligned.

---

## 3 · What your colleague focused more on

Areas his spec develops in depth that ours barely touches (mostly because they're tool-lane concerns):

- **A declarative permission-rule engine.** Host rules with `allow`/`ask`/`deny`, **typed argument
  predicates** (`path`/`url`/`command`/`json` with RFC-6901 pointers, symlink-aware path containment,
  URL credential rejection, no-regex bounded wildcards), provenance-aware matching, and **strict
  aggregation** (`deny > force_ask > allow > no_decision`). Ours has *no* declarative rule layer — our
  hooks are code/services, not argument-level allow/ask/deny rules.
- **Human approval / interactive consent.** `force_ask` bound to the exact tool-call id + effective-input
  digest, interactive vs unattended by resolver availability, and a full **approval snapshot / batch /
  resume** state machine. Ours has no human-in-the-loop concept at the LLM lane.
- **Exactly-once execution + resumability.** Suspended snapshots, resume re-checking admin policy without
  rerunning Pre hooks, idempotency keys, and a **doom-loop guard** (3 identical resolved-tool+input →
  deny). Ours treats the model call as a single completion — far less execution state.
- **A non-overridable admin hierarchy.** "Admin cannot be weakened" (G4) as a first-class invariant —
  Context policy strictly dominates Host rules/hooks/approvals. Ours has `global`/`context` scope but not
  a strict *dominance* rule.
- **Local sandboxed hook execution.** He solves the *trusted local executable* problem — least-privilege
  child processes, per-launch digest/owner/realpath verification, no shell, bounded stdio. (Ours sidesteps
  this by pushing hooks **out of process** instead — see §4.)
- **Persistence / prompt-injection hardening.** Routing raw `file_write` through the `WorkspaceService`
  scanner and treating `daily/*` memory as prompt-affecting. Not in our scope.
- **Heavy formal apparatus.** 15 invariants, a 17-row **threat model** (T1–T17 with preventive +
  detective controls and residual owners), 30 **acceptance scenarios** (A1–A30), a compatibility matrix,
  a work-package dependency graph, and an **external-semantics survey** (OpenAI/Claude/Cursor/OpenCode
  hook contracts). Ours is lighter on threat matrix / acceptance scenarios.

---

## 4 · What your spec focuses more on (the mirror)

The inverse — areas ours develops that his doesn't address (his spec never touches the model call):

- **Intercepting the LLM completion itself** — parallel `moderation`, PII redaction of model
  input/output, `prompt-shaping`, `token-trim`, and `on_error` **recover** (substituting a safe response).
  His hooks act only *after* the model has chosen a tool.
- **Remote + marketplace distribution.** Installable third-party hooks: a registry `entry_type:
  'llm_hook'`, an `install-hook` saga, image-allowlist/digest/egress trust, and **three delivery modes**
  (self-hosted pod, in-cluster Service, external endpoint) with a `llm-hooks` namespace. His hooks are
  **local-only, admin-allowlisted** — explicitly *not* a marketplace/sidecar/WASM.
- **Content-exposure governance for third-party code** — need-based + trust-gated message/response access.
  Not a concern for his local, no-network hooks.

---

## 5 · Where you disagree

The disagreements cluster in the **hook execution & trust model** — where, on the *same* question, the
two specs make opposing choices. The first five are fundamental (a single "hook" mechanism cannot
satisfy both); the last two are expressiveness gaps rather than contradictions.

| Question | Colleague (Guardrails) | Ours (LLM-hooks) | |
|---|---|---|---|
| **Where a hook runs** | a local child process inside the Host workload; non-goals **exclude** sidecar / WASM / remote | a **remote** service (own pod / in-cluster Service / external endpoint) | fundamental |
| **Network & side-effects** | **forbidden** — a deterministic JSON transform, "no independent external side effects," network stays outside the hook contract | **required** — guardrail/moderation/PII hooks call external services (e.g. `egressBindings` to a vendor API) | fundamental |
| **Who may author / install** | admin-**allowlisted**, digest-pinned; "no arbitrary user scripts" | **third-party marketplace** installs, gated by `trust_level` tiers | fundamental |
| **When a hook is down** | strict **fail-closed** — declared-but-unavailable policy ⇒ Host not Ready; digest mismatch never falls back | a per-hook **`onUnavailable: breaker`** may trip **fail-open** (with alerting) after N failures | fundamental (safety posture) |
| **May a hook fabricate the outcome?** | **no** — Post redacts the *model-visible view* only; it can't alter the stored outcome, and a deny yields a bounded error | **yes** — `on_error` **`recover`** substitutes a full safe response for a blocked/failed call | fundamental |
| **Decision expressiveness** | 4-valued `allow / force_ask / deny / no_decision`, **human `force_ask`**, and strict multi-source aggregation with precedence | `continue`/`reject` + moderation pass/fail + hard block; **no** human `ask`, no `defer`/`no_decision`, no aggregation | gap |
| **Config authority** | a **non-overridable** Context allowlist of hook id+phase+**digest** the Host can't exceed | scope (`global`/`context`) on a CRD; no per-digest allowlist the Host is bound to | gap |

**Reading it:** several of these are *lane-justified* — a tool guardrail genuinely should be a
deterministic local check, and an LLM moderation genuinely needs to call a service — so they're not
"someone is wrong." But they are the exact points that **collide if anyone tries to unify the two into
one "hook" mechanism**, and two stand out as posture disagreements worth an explicit decision even while
the specs stay separate:

1. **local-no-network vs remote-network** hooks (the trust boundary is inverted), and
2. **strict fail-closed vs fail-open breaker** when a hook is unavailable.

Everything *else* composes cleanly (shared digest/allowlist/no-secrets/HCC-artifact/bounded-audit
primitives on two stacked lanes) — so the recommendation stands: keep them as **two separate mechanisms**
and say so in both docs, but align deliberately on those two posture questions.
