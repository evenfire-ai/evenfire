# MCP Host Guardrails — spec suite

Guardrail / policy specs for the MCP Host, across **two lanes**:

- **LLM lane** — hooks on the model *completion* call (mutate/moderate the request, transform the
  response).
- **Tool lane** — permission rules + `Pre/PostToolUse` hooks + admin policy over *tool execution*
  (a colleague's draft, tracked externally as a Notion/PDF; not committed here).

## Documents

| Doc | Role |
|---|---|
| [`mcp-host-guardrails-unified-architecture.md`](./mcp-host-guardrails-unified-architecture.md) | **S0 · umbrella** — the shared spine + trust substrate that unifies the two lanes, and how the disagreements resolve |
| [`guardrails-vs-llm-hooks-comparison.md`](./guardrails-vs-llm-hooks-comparison.md) | analysis — where the two lanes **agree**, what each **emphasizes**, and where they **disagree** |
| [`llm-hooks-spec.md`](./llm-hooks-spec.md) | **S3 · LLM-lane adapter** — pre/post-call hooks (guardrail/PII/prompt-shaping/token-trim) + the marketplace/remote-hook substrate |

## Planned (not yet written)

Per the umbrella §2, the full suite is:

- **S1 · Guardrail Core** — decision algebra + aggregation, contributor contract, at-most-once/resume,
  admin-policy model + HCC delivery, bounded audit. *(new; mostly lifted from the tool-lane spec.)*
- **S2 · Tool-lane adapter** — the colleague's spec, re-homed on S1.
- **S4 · Hook trust & delivery substrate** — Tier A (local, digest-verified) + Tier B
  (remote/marketplace) and their governance. *(new; the main reconciliation work.)*

Status: all drafts, for discussion — no runtime/CRD/deployment change is authorized by these documents.
