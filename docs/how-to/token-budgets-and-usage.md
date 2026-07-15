# How to: track usage and set token budgets

Every LLM call evenfire makes is metered — tokens and cost, attributed to the
agent, team, user, provider, and model behind it. This guide covers where that
usage shows up, how to turn on **budgets** to cap it, and how a budget's `block`
vs `warn` decision actually behaves.

## What's tracked

Token usage (input, output, cache) and — once you set prices — cost, rolled up
by dimension: **agent** (Host), **team**, **user**, **provider**, and **model**.
Usage is recorded whether or not budgets are enabled.

## Where to see it

In the **Control UI → Cost & Usage → Usage** tab: token totals and a
stacked-area chart you can break down by agent, team, user, provider, or model.
See the [Control UI tour](../surfaces/control-ui.md) for the screens. Cost is
derived from the rates under the **LLM Prices** tab.

## Turn budgets on

Budgets are **off by default**. Set `CLERUM_BUDGETS_ENABLED=true` on
**`mcp-host`**, which is where enforcement runs. With the flag off, usage is
still tracked and budgets can still be created — nothing is enforced until the
flag is on.

## Create a budget

In **Control UI → Cost & Usage → Token Budgets**, add a budget with:

- **Scope** — which usage it covers: any combination of dimensions such as
  agent (Host), team, user, provider, and model. Leave it empty to cap
  **everything** (global).
- **Unit** — `tokens` or `cost`. A `cost` budget needs a currency and **priced
  models**: add rates under **LLM Prices** first. Creating a cost budget that
  pins unpriced models is rejected, so it cannot silently under-count.
- **Limit** and **period** — the cap, over a `daily`, `weekly`, or `monthly`
  window.
- **Enforcement** — `block` or `warn` (see below).

## `block` vs `warn`

- **`warn`** — observation only. The agent's call always proceeds; the budget
  just records that the scope is over its limit.
- **`block`** — when the scope is over its limit, the agent's next task is
  denied (`budget_exceeded`) and stops rather than spending more.

## What happens on failure

The two failure modes are deliberately different:

- If **`mcp-host` cannot reach** control-api's budget check at all (a network or
  service outage), the call **fails open** — the agent proceeds rather than
  being blocked by infrastructure it cannot control.
- If control-api **is** reachable but **cannot compute** a `block` budget's
  spend, it **fails closed** — the task is denied (`budget_eval_error`), because
  it cannot prove the task is under the cap.

A `warn` budget never blocks in either case.

## What budgets are not

Budgets are **cost control, not a security boundary**. They cap spend; they do
not authorize, isolate, or gate anything — that is the job of Contexts,
NetworkPolicies, and [approvals](configure-approvals.md). A cost budget is only
as accurate as the prices under **LLM Prices**.

## Related

- [Control UI](../surfaces/control-ui.md) — the Cost & Usage, LLM Prices, and Token Budgets screens
- [Configure approvals](configure-approvals.md) — the other half of governed action
- [Add an MCP server](add-mcp-server.md) — give an agent tools to spend against
