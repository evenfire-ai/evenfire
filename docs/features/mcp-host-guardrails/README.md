# MCP Host Guardrails — spec suite

One guardrail/policy framework for the MCP Host, spanning **two lanes**:

- **LLM lane** — guardrails on the model *completion* call (mutate/moderate the request, transform the
  response, recover on failure).
- **Tool lane** — guardrails on *tool execution* (permission rules + `Pre/PostToolUse` hooks + admin
  policy + approvals).

The two lanes share one decision/policy/audit machine (**S1**) and one hook trust/delivery substrate
(**S4**); each lane is an adapter (**S2**, **S3**) over that shared foundation.

## Suite

| Spec | Scope |
|---|---|
| [`00-unified-architecture.md`](./00-unified-architecture.md) | **S0** — the umbrella: the shared abstraction, the suite map, and how the lanes' differences reconcile |
| [`01-guardrail-core.md`](./01-guardrail-core.md) | **S1** — lane-neutral core: decision algebra + aggregation, contributor contract, at-most-once/resume, admin policy + HCC delivery, bounded audit |
| [`02-tool-lane-adapter.md`](./02-tool-lane-adapter.md) | **S2** — tool lane: permission rules + typed predicates, `Pre/PostToolUse`, provenance, approvals, doom-loop, persistence |
| [`03-llm-lane-adapter.md`](./03-llm-lane-adapter.md) | **S3** — LLM lane: `HookedLlmPort`, `pre_call`/`moderation`/`post_call`/`on_error`, built-ins |
| [`04-hook-trust-and-delivery.md`](./04-hook-trust-and-delivery.md) | **S4** — hook tiers (local digest-verified vs remote/marketplace), invocation, install, egress, credential isolation |

## Status

All documents are **drafts for discussion**. No runtime, CRD, or deployment change is authorized by this
suite — it is a specification. Each spec is self-contained; cross-references stay within the suite
(S0–S4).
