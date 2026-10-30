# How to: track usage and set token budgets

Every LLM call evenfire makes is metered: tokens and, once you set prices,
cost. Each call is attributed to the agent, team, user, provider, model, and
other dimensions behind it. This guide covers where that usage shows up, how
to turn on **budgets** to cap it, and how a budget's `block` vs `warn` decision
actually behaves.

## What's tracked

Token usage (input, output, cache read, cache write) is rolled up by the
dimensions in the table below. Cost is derived from token counts and the rates
under **LLM Prices**. Usage is recorded whether or not budgets are enabled.

| Dimension         | Control UI label | What it is                                                                                           |
| ----------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| `host_ref`        | Agent            | The agent (Host) that made the call                                                                  |
| `context_ref`     | Connector scope  | The Context the agent is bound to                                                                    |
| `team_id`         | Team             | The team the call is attributed to                                                                   |
| `user_id`         | User             | The Desktop App user. Set for Desktop App calls only                                                 |
| `provider`        | Provider         | The LLM provider, such as `claude` or `openai`                                                       |
| `model`           | Model            | The model ID                                                                                         |
| `llm_secret_name` | Secret           | The LLM credential secret the call used                                                              |
| `source_kind`     | Source           | What started the call: `channel`, `desktop`, `workflow`, `cron`, `plugin_workload_sdk`, or `unknown` |
| `recipe_name`     | Recipe           | The workflow recipe (plugin) behind the call                                                         |
| `cron_job_id`     | Cron job         | The agent's scheduled job. Set for cron calls only                                                   |

For channel calls that carry no team, the team is resolved from the agent's
Context: the team bound to that Context earliest wins.

## Where to see it

Open **Control UI → Cost & Usage** (`/cost-and-usage`). It has three tabs:

| Tab           | Path                            |
| ------------- | ------------------------------- |
| Usage         | `/cost-and-usage/usage`         |
| Token Budgets | `/cost-and-usage/token-budgets` |
| LLM Prices    | `/cost-and-usage/llm-prices`    |

The **Usage** tab shows token totals and a stacked-area chart over the last
24 hours, 7 days, or 30 days. **Break down by** splits the chart by Team,
Recipe, Model, Provider, Agent (host), LLM secret, Desktop user, or Source
kind. Some breakdowns filter by source:

- **Recipe** shows workflow calls only.
- **Agent (host)** leaves out workflow calls, so recipe Hosts do not show up
  as agents.
- **Desktop user** shows Desktop App calls only.

See the [Control UI tour](../surfaces/control-ui.md) for the screens.

## Turn budgets on

Budget enforcement is **off by default** in code. Set
`CLERUM_BUDGETS_ENABLED=true` on **`mcp-host`**, which is where enforcement
runs. The minikube overlay already sets it to `true` in its `mcp-host-config`
ConfigMap. With the flag off, usage is still tracked and budgets can still be
created, but nothing is enforced.

## Create a budget

Go to **Cost & Usage → Token Budgets → New budget** (`/cost-and-usage/token-budgets/new`)
and fill in these fields:

| Field                      | What it does                                                                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**                   | A label for the budget                                                                                                                                                                                                                                                  |
| **Unit**                   | `tokens` (raw count) or `cost` (currency). A `cost` budget needs a currency and **priced models**. Add rates under **LLM Prices** first. Creating a cost budget whose scope names an unpriced model is rejected (`unpriced_models`), so it cannot silently under-count. |
| **Limit amount**           | The cap for one period                                                                                                                                                                                                                                                  |
| **Period**                 | `daily`, `weekly`, or `monthly`. Calendar-aligned: spend resets at the start of each period.                                                                                                                                                                            |
| **Timezone**               | Fixed to UTC in this version                                                                                                                                                                                                                                            |
| **Min remaining to start** | A new task is denied when the remaining amount is below this. Default `0`, which means a task can start while anything remains.                                                                                                                                         |
| **Max per task**           | Optional. A per-task cap. See [Per-task cap](#per-task-cap).                                                                                                                                                                                                            |
| **Enforcement**            | `warn` or `block`. See below.                                                                                                                                                                                                                                           |
| **Enabled**                | Disabled budgets are ignored for spend and checks                                                                                                                                                                                                                       |
| **Scope**                  | Which usage the budget covers. Leave it empty to cap **everything** (a global budget).                                                                                                                                                                                  |

### Scope

A scope is a set of dimensions, each with one or more values. Different
dimensions are ANDed. Values within one dimension are ORed. For example,
team `A` and provider `claude` or `openai` matches only team `A`'s calls to
either provider.

The scope editor in the form offers six dimensions: Provider, Model, Team,
User, Agent, and Secret. The budgets API (`/api/v1/admin/budgets`) also
accepts `context_ref`, `source_kind`, `recipe_name`, and `cron_job_id`. A
budget saved with those through the API is shown with its full scope in the
Control UI. Any other scope key is rejected.

A scope on `user_id` only matches Desktop App calls, because those are the
only calls that carry a user.

## `block` vs `warn`

Every matching budget is checked once per task. The most restrictive one wins.

- **`warn`** is observation only. The task always proceeds. When the scope is
  under its minimum, control-api logs it.
- **`block`** denies the next task (`budget_exceeded`) when the remaining
  amount is below **Min remaining to start**. The task stops instead of
  spending more.

### Per-task cap

**Max per task** applies to `block` budgets only. When several matching
budgets set it, the smallest cap per unit applies. mcp-host tracks the tokens,
or cost, that one task has used and stops the task before its next LLM call
once it goes over the cap.

When the remaining amount is already below one task's cap, control-api also
reserves that cap for the starting task. That way two tasks that start at the
same moment cannot both spend the last of the budget.

## What happens on failure

The two failure modes are deliberately different:

- If **`mcp-host` cannot get a usable answer** from control-api's budget check
  (network error, timeout, a non-200 response, or a malformed body), the task
  **fails open** and proceeds. mcp-host logs `budget_check_failed`. It retries
  once with a fresh token on `401` first, so a token rotation does not let a
  task skip an exceeded budget.
- If control-api answers but **cannot compute** a `block` budget's spend, it
  **fails closed**. The task is denied (`budget_eval_error`), because
  control-api cannot prove the task is under the cap.

A `warn` budget never blocks in either case.

## What budgets are not

Budgets are **cost control, not a security boundary**. They cap spend. They do
not authorize, isolate, or gate anything: that is the job of Contexts,
NetworkPolicies, [guardrails](configure-guardrails.md), and
[approvals](configure-approvals.md). A cost budget is only as accurate as the
prices under **LLM Prices**.

## Related

- [Control UI](../surfaces/control-ui.md): the Cost & Usage screens
- [LLM providers](../llm-providers/README.md): the providers and secrets usage is attributed to
- [Configure approvals](configure-approvals.md): the other half of governed action
- [Add an MCP server](add-mcp-server.md): give an agent tools to spend against
