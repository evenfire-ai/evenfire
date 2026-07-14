# Claims guardrails (README & public docs)

> Committed subset of the never-overclaim checklist from the README improvement
> plan. Run this gate whenever editing root `README.md` or marketing-facing docs.

Every public claim must be backed by code in **this** repo. Prefer honest
caveats over absolute language.

## Never claim

| Do not write                                            | Prefer                                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Per-domain egress allowlisting for SaaS connectors      | Port/CIDR egress with documented FQDN limits                                                                   |
| “Any model” / every provider under the sun              | Four providers; OpenAI-compatible entries are config                                                           |
| Gemini (or other non-shipped) as a first-class provider | Only `openai` / `claude` / `zai` / `bailian`                                                                   |
| MiniMax as a direct provider                            | Via Bailian catalog (Qwen/GLM/Kimi/MiniMax models)                                                             |
| Context memory always-on                                | Built-in pre-pruning + tiered compaction; **configurable**                                                     |
| Usage/cost in Grafana / `monitoring/`                   | control-api + control-ui (token dashboards, prices, budgets)                                                   |
| Token budgets as a security boundary                    | Cost control; fail-open                                                                                        |
| Universal JWT on mcp-host inbound                       | Layered: edge trust headers (dev AND prod) + NetworkPolicy; JWT middleware guards only specific control routes |
| Edge trust headers as dev-only                          | Same headers are prod app-layer auth; NetworkPolicy is what changes                                            |
| Plugin/connector images "pinned by sha256"              | Digest pinning is for custom coordinator images; connector images use an allowlist, audit-mode by default      |
| GFS audit as WORM / immutable                           | Tamper-**evident** hash-chained log                                                                            |
| SFS multi-writer everywhere                             | Read-only into agents; RWO single-node default unless stated                                                   |
| First-party Airtable/Mongo MCP images                   | Upstream images + platform packaging                                                                           |
| Audit-logging for external-rest-api if still future     | Only what the code ships today                                                                                 |
| “Source-available” / “not open source” / Apache-2.0     | MPL-2.0 since 2026-07-13 — OSI-approved, file-level copyleft                                                   |
| Stale test counts from service READMEs                  | Recount or use conservative aggregates                                                                         |

## Always state (when relevant)

- License is **MPL-2.0** (OSI open source; file-level copyleft)
- Public name **evenfire** / code name **clerum** (`clerum.io`, `CLERUM_*`)
- Single-service dev mode (`CLERUM_DEV_MODE`) is **not** full platform security
- Budgets are cost control, not security
- Approvals default-on for **MCP** tools (native tool overrides exist)

## Review checklist

- [ ] No competitor product names in root README (positioning stays category-only)
- [ ] Features use vocabulary bridge: site term ↔ CRD/component
- [ ] Security section includes four pillars + layered auth caveat
- [ ] All relative links resolve
- [ ] Test numbers recounted or phrased as order-of-magnitude without false precision
