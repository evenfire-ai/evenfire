# S0 · MCP Host Guardrails — Unified Architecture

|  |  |
|---|---|
| **Type** | architecture / umbrella spec |
| **Status** | draft for discussion |
| **Suite** | S1 [core](./01-guardrail-core.md) · S2 [tool-lane](./02-tool-lane-adapter.md) · S3 [llm-lane](./03-llm-lane-adapter.md) · S4 [trust & delivery](./04-hook-trust-and-delivery.md) |
| **Scope** | specification only — no runtime/CRD/deployment change is authorized here |

---

## 0 · Thesis

The MCP Host applies guardrails on two lanes — the **LLM completion** and **tool execution** — and both
are the same machine: *intercept a call → run an ordered chain of policy contributors → aggregate to a
decision → execute at-most-once → emit bounded audit.* They differ only in **what** they intercept and
in the **trust model of their hooks**.

So this suite is a **shared spine + two lane adapters + a shared trust substrate**, not one merged
document:

- **S1 · Guardrail Core** — the common decision/policy/audit machine.
- **S2 / S3 · Lane adapters** — tool lane and LLM lane, each specialized over S1.
- **S4 · Hook trust & delivery** — the substrate that lets a *local, digest-verified* hook and a
  *remote, marketplace* hook coexist as explicit tiers.

```mermaid
flowchart TB
  REQ["task / user request"] --> S3B["S3 · LLM-lane boundary<br/>HookedLlmPort (pre / moderate / post / on_error)"]
  S3B --> MODEL["model completion"]
  MODEL --> TC["model emits a tool call"]
  TC --> S2B["S2 · Tool-lane boundary<br/>rules + PreToolUse → execute → PostToolUse"]
  S2B --> EXEC["tool executes (at-most-once)"]
  S3B -. decision algebra · admin policy · at-most-once · audit .-> CORE["S1 · Guardrail Core"]
  S2B -. .-> CORE
  S3B -. hooks delivered by .-> SUB["S4 · Hook trust &amp; delivery<br/>Tier A local · Tier B remote"]
  S2B -. .-> SUB
```

---

## 1 · The unifying abstraction — one `GuardrailBoundary`

Each lane instantiates one boundary over its own call/result types (defined fully in S1):

| Stage | Shared contract (S1) | LLM lane (S3) | Tool lane (S2) |
|---|---|---|---|
| Intercept | a call reaches a mandatory boundary | `HookedLlmPort` at `LlmPort` | resolved tool call before execution |
| Contributors | ordered chain of **rules + hooks + validators** | moderation, prompt-shaping, token-trim, PII | permission rules, Pre hooks, hard validators |
| Decision | `allow / ask / deny / no_decision`, strict aggregation `deny > ask > allow > no_decision` | reject→`deny`, moderation-fail→`deny`, continue→`allow` | as authored |
| Rewrite | full input replacement, canonicalize + revalidate | `pre_call` patch | Pre-hook `updatedInput` |
| Execute | **at-most-once**, snapshot-safe | one completion per logical request (above failover) | `executeSingleTool`, batch/resume |
| Post | transform the model-visible result; never alter the authoritative outcome | `post_call`; `on_error` recover (gated) | `PostToolUse` |
| Evidence | bounded-enum metrics + redacted, digest-based audit | S3 audit | S2 audit |

A **contributor** is the shared unit: `{ phase: pre|post, source: admin_rule|host_rule|hook|validator,
decision, reasonCode, rewrite?, capabilities? }`. Rules are declarative contributors; hooks are
executable contributors delivered per S4.

---

## 2 · How the lanes' differences reconcile

The two lanes independently agree on the trust primitives (universal mediation, no-secrets-in-hooks,
digest/allowlist trust, HCC-delivered admin policy, at-most-once, bounded audit). Where they diverge,
the resolution lives at the spine:

| Divergence | Resolution | Home |
|---|---|---|
| Hook runs **local** vs **remote** | not either/or — **two tiers**; a hook declares its tier, admin policy admits tiers per lane/Context | S4 |
| Hook **network/side-effects** | derived from tier: Tier A none/deterministic; Tier B egress-allowlisted | S4 |
| Who **installs** | one **non-overridable Context admin policy** governs both tiers | S1 + S4 |
| **Fail-open vs fail-closed** on hook-down | fail-closed is mandatory for any deny-authoritative hook; a `breaker` fail-open is allowed only for advisory hooks the admin opts in | S1 + S4 |
| Hook **fabricating the outcome** | a named, admin-granted, audited `may_substitute_result` capability that never alters the stored outcome | S1 + S4 |
| **Decision expressiveness** | the 4-valued algebra + strict aggregation for both lanes | S1 |

The load-bearing move is the **tiered hook model** (S4): **Tier A** (trusted local, digest-verified,
no-network, may be deny-authoritative) and **Tier B** (remote/marketplace, network-permitted,
`trust_level`-gated, advisory unless strongly gated). Admin policy declares, per Context and lane, which
tiers and which capabilities (`may_deny`, `may_rewrite`, `may_substitute_result`) are admissible — so the
two specs' opposite instincts become expressible policy instead of contradiction.

---

## 3 · Sequencing

1. **S1 (Core)** — lift the decision algebra, contributor contract, at-most-once/resume, admin-policy
   model, and audit out of the lane specifics into a lane-neutral core.
2. **S4 (Trust substrate)** — define Tier A + Tier B and the admin-policy tier/capability grants.
3. **S2 / S3 (adapters, in parallel)** — each conforms to S1 and consumes S4; keeps its lane depth.

Dependencies: S1 → {S4, S2, S3}; S4 → {S2, S3}. The open decisions in §4 gate S1's scope.

---

## 4 · Open decisions

1. Does the **LLM lane need `ask`** (human approval before a model call)? If not, `ask` is tool-lane-only.
2. May **tool-lane guardrails ever be Tier B** (remote), or local-only?
3. Is **`may_substitute_result`** allowed on the tool lane, or LLM-only?
4. Is **Guardrail Core** an in-process shared library (both lanes run in mcp-host) or a separate module?
5. **Unify the reason-code registries**, or keep per-lane with a shared bounded-label discipline?
6. Minimal **capability set** — is `{may_deny, may_rewrite, may_substitute_result}` enough, or also
   `may_ask` / `may_add_context`?

---

## 5 · Out of scope for the spine

The spine must not absorb lane mechanics: the tool lane's typed argument predicates, provenance, doom-loop,
and persistence scanner (S2); and the LLM lane's `token-trim`/`prompt-shaping` built-ins and
`HookedLlmPort` placement (S3). Those stay in the adapters.
