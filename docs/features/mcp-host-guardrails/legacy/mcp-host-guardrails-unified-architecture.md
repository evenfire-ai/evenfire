# Spec · MCP Host Guardrails — Unified Architecture (umbrella)

|  |  |
|---|---|
| **Type** | architecture / umbrella spec — decomposes into the suite in §2 |
| **Status** | draft for discussion |
| **Combines** | *(DRAFT) MCP Host Guardrails — Permission Rules, Hooks & Admin Policy* (tool lane) + [`llm-hooks-spec.md`](./llm-hooks-spec.md) (LLM lane) |
| **Companion** | [`guardrails-vs-llm-hooks-comparison.md`](./guardrails-vs-llm-hooks-comparison.md) — the agree / emphasize / disagree analysis this design resolves |

---

## 0 · Thesis

The two specs are the same machine on two lanes: **intercept a call → run an ordered chain of policy
contributors → aggregate to a decision → execute at-most-once → emit bounded audit.** They differ in
*what* they intercept (an LLM completion vs a resolved tool call) and in the *trust model of their
hooks* (remote/marketplace vs local/digest-verified).

So the combination is **not** one merged document. It is:

1. a **shared guardrail spine** (the common decision/policy/audit machine),
2. **two lane adapters** (the two existing specs, re-homed on that spine), and
3. a **shared hook trust & delivery substrate** that makes the two hook models coexist as explicit tiers.

Everything the two specs *agree* on (comparison §2) becomes the spine; everything they *disagree* on
(comparison §5) is resolved once, at the spine (§3 below).

---

## 1 · The unifying abstraction — one `GuardrailBoundary`

Define the boundary once; each lane instantiates it over its own call/result types.

| Stage | Shared contract | LLM lane (`llm-hooks`) | Tool lane (Guardrails) |
|---|---|---|---|
| **Intercept** | a call reaches a mandatory boundary (G1) | `LlmPort.completeWithTools` (`HookedLlmPort`) | resolved tool call before execution |
| **Context** | identity + resolved target + original/effective input | model, `usageContext` | resolved tool, provenance, args |
| **Contributors** | ordered chain of *rules* + *hooks* + *validators*, each emitting a decision | moderation, prompt-shaping, token-trim, PII hooks | permission rules, Pre hooks, hard validators |
| **Decision** | `allow / ask / deny / no_decision`, strict aggregation `deny > ask > allow > no_decision` | reject→`deny`, moderation-fail→`deny`, continue→`allow` | as authored |
| **Rewrite** | full input replacement, canonicalize + **revalidate** (G7) | `pre_call` `patch` | Pre-hook `updatedInput` |
| **Approve** | if `ask`: exact-call resolver, else fail-closed | (usually N/A — see §6) | `force_ask` snapshot/resume |
| **Execute** | **at-most-once**, snapshot-safe across resume (G11/G12) | one completion per logical request (above failover) | `executeSingleTool`, batch/resume |
| **Post** | transform the *model-visible* result; never alter the authoritative outcome | `post_call_success`; `on_error` recover (gated, §3) | `PostToolUse` |
| **Evidence** | bounded-enum metrics + redacted, digest-based audit (G15) | §6 audit | §13 audit |

A **contributor** is the shared unit: `{ phase: pre|post, source: admin_rule|host_rule|hook|validator,
decision, reasonCode, rewrite?, capabilities? }`. Rules are declarative contributors; hooks are executable
contributors. The lane supplies the input/result types; the spine supplies the algebra.

---

## 2 · Spec suite (thinking in multiple specs)

| Spec | Owns | Sourced from |
|---|---|---|
| **S0 — this doc** | the umbrella: shared abstraction, reconciliation, spec map, migration | new |
| **S1 — Guardrail Core** | decision algebra + strict aggregation, the contributor contract, at-most-once + snapshot/resume, admin-policy model + **HCC atomic-artifact delivery**, bounded metrics/audit, reason-code registry | shared parts of both (Guardrails §3–6, §10, §11, §13; llm-hooks §1.2–1.3, §6) |
| **S2 — Tool-lane adapter** | permission **rules** + typed argument predicates, provenance, `Pre/PostToolUse`, approvals/`force_ask`, doom-loop, persistence/scanner hardening | the colleague's spec, re-homed |
| **S3 — LLM-lane adapter** | `pre_call`/`moderation`/`post_call`/`on_error`, built-ins (`prompt-shaping`/`token-trim`/PII), `HookedLlmPort` placement above failover | `llm-hooks-spec.md`, re-homed |
| **S4 — Hook trust & delivery substrate** | the **two hook tiers** (§3.1), digest/allowlist verification (Tier A), marketplace registry + `install` saga + image-allowlist + `trust_level` (Tier B), egress policy, credential isolation | Guardrails §9 + llm-hooks §3/§5, unified |

S1 and S4 are the new work; S2 and S3 are the existing specs demoted to **adapters** that conform to S1
and consume S4. Neither existing doc is thrown away — each keeps its lane-specific depth.

---

## 3 · Reconciling the disagreements (resolved at the spine)

The comparison's §5 conflicts, decided once:

| Disagreement | Unified resolution | Why it holds |
|---|---|---|
| **Where a hook runs** (local vs remote) | Not either/or — **two tiers** (§3.1). A hook declares its tier; the spine + admin policy decide which tiers a given lane/Context may use. | A deterministic tool check and a network moderation call are both legitimate; the tier makes the trust rules explicit rather than global. |
| **Network & side-effects** | Derived from tier: **Tier A = no network / deterministic**; **Tier B = network-permitted, egress-allowlisted**. | Preserves the colleague's determinism guarantee where it matters and our vendor-call capability where it's needed. |
| **Who authors/installs** | **Admin policy governs both tiers.** Tier A = admin-allowlisted digests. Tier B = marketplace install that must satisfy a Context allowlist + `trust_level` floor. | Adopts his non-overridable Context authority as the single governance model for both. |
| **When a hook is down** | **Fail-closed is the default and is mandatory for any decision-authoritative (deny-capable) hook.** A `breaker`/fail-open is permitted **only** for non-authoritative (advisory/observability) hooks and **only** when admin policy opts in. | Keeps his strict posture for anything that can block; allows our availability trade-off exactly where it's safe. |
| **May a hook fabricate the outcome?** | Recovery/substitution is a **named capability** (`may_substitute_result`) an admin must grant; the substitute is **clearly hook-originated + audited** and **never alters the stored authoritative outcome** (his G12 holds). | Our `on_error recover` survives, but as a gated, auditable exception rather than a default power. |
| **Decision expressiveness** | Adopt the **4-valued algebra + strict aggregation for both lanes**. The LLM lane gains `ask`/`no_decision` (used rarely — §6). | One decision model; the LLM lane's simpler cases are just the subset it uses. |
| **Config authority** | The **non-overridable Context admin policy** governs rules, allowed hook tiers, allowed hook digests/entries, allowed approval policies, and limits — for **both** lanes. | Single governance surface; marketplace installs and local hooks both bind to it. |

### 3.1 · The tiered hook model (the load-bearing move)

| | **Tier A — trusted local** | **Tier B — remote / marketplace** |
|---|---|---|
| Runs as | least-privilege child process in the workload | own pod / in-cluster Service / external endpoint |
| Network | none (deterministic transform) | permitted, egress-allowlisted |
| Trust | admin-allowlisted, digest-pinned | image-allowlist + sha256 digest + `trust_level` |
| Author | first-party / operator-vetted | third-party marketplace |
| Fail-mode | fail-closed (may be deny-authoritative) | fail-closed if deny-authoritative; `breaker` only if advisory + admin-opted-in |
| Typical use | tool-lane permission checks, high-assurance guardrails | LLM moderation/PII that call vendor services |

**Rule:** admin policy declares, per Context and per lane, which tiers are admissible and which
capabilities (`may_deny`, `may_rewrite`, `may_substitute_result`) each hook is granted. A lane can require
Tier A for anything decision-authoritative and allow Tier B only for advisory contributions — which is
exactly how the two specs' instincts differ, now expressible instead of contradictory.

---

## 4 · How the existing specs slot in (no rework of their depth)

- **Tool lane (S2)** already speaks the spine's language: its `allow/ask/deny/no_decision`, strict
  aggregation, `Pre/PostToolUse`, at-most-once/resume, and admin policy **are** the spine's canonical
  forms. It contributes almost all of S1. Its hooks are **Tier A**.
- **LLM lane (S3)** maps on cleanly: `pre_call`→pre contributor (rewrite/deny), `moderation`→pre
  contributor (deny/ask), `post_call_success`→post contributor, `on_error recover`→post with
  `may_substitute_result`, `token-trim`/`prompt-shaping`→rewrite contributors. Its remote hooks are
  **Tier B**; its built-ins are in-process **Tier A**-equivalent (first-party, no network).

Net: the tool-lane spec is ~the spine already; the LLM-lane spec is the same machine specialized to the
model call plus the Tier-B substrate.

---

## 5 · Sequencing / migration

1. **S1 — Guardrail Core** first: lift the decision algebra, contributor contract, at-most-once/resume,
   admin-policy model, and audit/metrics out of the tool-lane spec into a lane-neutral core.
2. **S4 — Trust substrate**: define Tier A (local digest-verified execution) + Tier B (marketplace/remote)
   and the admin-policy tier/capability grants.
3. **S2 / S3 — adapters**: re-home each existing spec as an adapter that *conforms to* S1 and *consumes*
   S4. Most of their text is unchanged; the delta is pointing shared concepts at S1/S4 instead of
   redefining them.
4. Both existing docs get a one-line header: "Lane adapter of the unified guardrail architecture (S0);
   shared model in S1, trust substrate in S4."

No production code, CRD, or deployment change is authorized by this document (consistent with both
source specs); this is a specification decomposition.

---

## 6 · Open decisions for the authors

Genuine forks the unification surfaces — worth an explicit call before S1 is written:

1. **Does the LLM lane need `ask` (human approval before a model call)?** Likely rare (cost/risk gating on
   an expensive model, or a jailbreak-suspected turn). If never needed, the LLM adapter uses only
   `allow`/`deny`/`no_decision` and `ask` is a tool-lane-only feature of the shared algebra.
2. **May tool-lane guardrails ever be Tier B (remote)?** The colleague's spec says local-only. Holding
   that line is safest; allowing a remote tool guardrail (strongly gated) would let teams reuse a shared
   policy service across lanes. Decide whether Tier B is admissible on the tool lane at all.
3. **Is `may_substitute_result` allowed on the tool lane** (substitute a tool result), or LLM-only?
   His model forbids altering a tool outcome; keeping substitution LLM-only preserves that.
4. **Where does Guardrail Core live** — an in-process mcp-host library, or a shared module both the tool
   and LLM lanes import? (Both lanes already run inside mcp-host, so a shared library is the likely form.)
5. **Unify the reason-code registries** into one enum, or keep per-lane registries that share a bounded-label
   discipline? A single registry eases cross-lane dashboards.
6. **Capability granularity** — is `{may_deny, may_rewrite, may_substitute_result}` the right minimal set,
   or do we also need `may_ask` and `may_add_context` as separately grantable?

---

## 7 · Explicitly out of scope (stays lane-specific)

The spine must **not** absorb lane mechanics that don't generalize: the tool lane's typed argument
predicates (`path`/`url`/`command`/`json`), provenance-from-registry, doom-loop guard, and persistence
scanner; and the LLM lane's `token-trim`/`prompt-shaping` built-ins, model-context projection, and
`HookedLlmPort` placement above failover. These live in S2/S3, not S1.
