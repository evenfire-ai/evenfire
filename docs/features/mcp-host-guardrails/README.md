# MCP Host Guardrails

One guardrail/policy framework for the MCP Host, spanning **two lanes**:

- **LLM lane** — guardrails on the model *completion* call (mutate/moderate the request, transform the
  response, recover on failure).
- **Tool lane** — guardrails on *tool execution* (permission rules + `Pre/PostToolUse` hooks + admin
  policy + approvals).

Both lanes use one shared decision engine (the `allow`/`ask`/`deny` logic, admin policy, at-most-once
execution, audit) and one shared "how hooks run and are trusted" layer.

## Spec

**→ [`mcp-host-guardrails-spec.md`](./mcp-host-guardrails-spec.md)** — the single, self-contained design
spec. Read top-to-bottom: overview → the shared `GuardrailBoundary` machine → decision algebra →
execution safety → the one `Host.spec.guardrails` config block → the tool lane → the LLM lane → hook
trust & delivery → evidence → open decisions → invariants.

## Status

**Draft for discussion.** No runtime, CRD, or deployment change is authorized by this spec — it is a
specification.

## History

Superseded material is archived under [`legacy/`](./legacy/), in two folders:

- [`legacy/split-suite/`](./legacy/split-suite/) — the five-document version this spec merges (S0
  architecture, S1 core, S2 tool lane, S3 LLM lane, S4 hook trust & delivery).
- [`legacy/early-drafts/`](./legacy/early-drafts/) — the earlier exploratory drafts that preceded the
  suite (the original LLM-hooks spec, the tool-lane-vs-LLM-hooks comparison, and the first unified
  architecture sketch).
