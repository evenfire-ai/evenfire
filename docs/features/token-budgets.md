# Token Budgets & Cost Enforcement

Token budgets let an admin cap LLM consumption — either raw **tokens** or
converted **cost** (currency) — over a rolling period, scoped to a slice of
traffic (a user, a team, a provider, a model, an agent, a workflow recipe, or
globally). Before an agent turn runs its LLM call, or before a workflow step
does, evenfire (code name **clerum**) checks the matching budgets and can block
the request once the period's limit is reached.

> **Budgets are a cost-control mechanism, not a security boundary.** The check
> path is **fail-open**: if the flag is off, no budget client is wired, or
> control-api is unreachable, the task is allowed. A denial always means a real
> budget verdict — never a transport error.

---

## 1. What it is and why

The feature enforces spend limits on the LLM usage produced by **agent turns**
and **workflow steps**. Each budget targets a scope, carries a per-period limit
in one unit (tokens or cost), and runs in one of two modes: `warn`
(observation only — logs, never denies) or `block` (denies once the limit is
reached). Spend is computed on demand from the usage rollups (`usage_daily` /
`usage_5min`), so there is no materialized counter to drift; the tradeoff is
that rollups lag roughly 1–2 minutes.

## 2. Enabling it

Budget enforcement is gated by a single boolean env var on **mcp-host**:

| Env var                   | Default        | Effect                                                              |
| ------------------------- | -------------- | ------------------------------------------------------------------- |
| `CLERUM_BUDGETS_ENABLED`  | `false` (OFF)  | Gates the whole check path (BudgetClient + SessionProcessor wiring) |

It is **OFF by default.** When off, the agent and workflow budget checks are
no-ops that resolve `{ allowed: true }`
(`mcp-host/src/config.ts:619`, comment at `153–156`).

The **minikube overlay turns it ON explicitly**:

```yaml
# deploy/overlays/minikube/configmaps/mcp-host-config.yaml
CLERUM_BUDGETS_ENABLED: "true"
```

## 3. How it works

### Lifecycle: reserve → execute → release

1. **Check (read-only).** Once per task, mcp-host calls
   `POST /api/v1/internal/budgets/check`. control-api's `evaluateBudgetCheck`
   loads the enabled budgets (5s in-memory cache), filters them by scope match,
   and for each matching budget computes `spent` and
   `remaining = limit_amount − spent`. The decision is **most-restrictive-wins**.
2. **Reserve (only in the danger zone).** A reservation is an *ephemeral
   anti-race guard*, not a persistent counter. It is taken **only** when a
   matching `block` budget is in the danger zone
   (`max_task_amount != null && remaining < max_task_amount`). Outside the
   danger zone the check is a pure read with no lock or transaction. Inside one
   transaction holding `pg_advisory_xact_lock(hashtext(budget_id))`, it sums the
   `est_amount` of non-expired reservations as `pending`, computes
   `effective_remaining = limit − spent − pending`, and DENIES if that is below
   `min_start_amount`; otherwise it inserts a reservation row
   (`est_amount = max_task_amount`, `expires_at = NOW() + TTL`, `task_ref`,
   `host_ref`) and allows.
3. **Release / settle.** On task terminal, mcp-host calls
   `POST /api/v1/internal/budgets/release` (by `task_ref`, scoped to the
   caller's `host_ref`) to drop the reservation early — fire-and-forget.
   Otherwise the reservation self-expires by TTL. **There is no explicit
   "settle actuals into the budget" step:** real spend lands separately via the
   usage-event rollups, and the reservation is purely released or expired.

**Reservation TTL** defaults to **300 seconds** (`BUDGET_RESERVATION_TTL_SECONDS`).
Expired reservations stop counting immediately (the pending sum filters
`expires_at > NOW()`) even before the sweep deletes them — this is the
fail-open safety so a stuck task never blocks a budget permanently.

### Exceed behavior: warn vs block

Enforcement is a per-budget column defaulting to `block`.

- **`warn` budgets NEVER deny.** Over the limit, they only log
  `budget_would_block` (observation mode).
- **`block` budgets deny** (fail-closed) once the limit is reached.
- A **`block` budget that cannot be evaluated** (spend computation error)
  DENIES with reason `budget_eval_error` (anti-bypass). A real exceed sets
  reason `budget_exceeded`; losing a danger-zone reservation to a concurrent
  task also denies with `budget_exceeded`.
- A **`warn` budget that errors is skipped** entirely — never denies, imposes no
  brake.

### Per-task brake (`max_task_amount`)

Distinct from the per-period limit, the check also returns a per-task cap
(`maxTaskTokens` / `maxTaskCost`) = the **MIN of `max_task_amount` across
matching `block` budgets**, by unit. Only `block` budgets impose a brake.

### Agent turns vs workflow steps

Both paths are **fail-open across services**: if control-api is unreachable or
throws, mcp-host's `checkTaskBudget` and the SessionProcessor resolve
`{ allowed: true }`.

- **Agent turns.** SessionProcessor runs `checkTaskBudget` after the lifecycle
  transition to `processing` and before the executor. On deny it calls
  `onBudgetDenied → AgentStateMachine.handleBudgetDenied`, failing the task via
  the canonical failure path. The caller sees:
  - error code `BUDGET_EXCEEDED`
  - message: *"This period's consumption budget has been reached. Please try
    again later."*
  - `retryable: false`
  - lifecycle status `failed`
- **Workflow steps.** `WorkflowService.runStepBudgetCheck` runs a pre-step check
  (`source_kind = 'workflow'`, `context_ref = null`, team/user resolved
  server-side, `task_ref = 'wf:{recipe}:{stepId}:{execId}'`). On deny, the step
  returns `status = 'failed'` with error string
  `budget_exceeded: {reason}`, and the LLM is never called. Same block/warn
  semantics; the deny surfaces as a failed step result rather than an agent
  task-failure error object.

## 4. Budget scopes

A budget's target is a JSONB `scope` object. Keys are **ANDed**, values within a
key are **ORed**, and an empty scope `{}` matches everything (global). A strict
zod schema rejects any key outside the allowlist (anti-injection); each
dimension maps to a non-empty `string[]`.

The ten allowlisted dimensions:

| Dimension         | Targets                          |
| ----------------- | -------------------------------- |
| `user_id`         | a user                           |
| `team_id`         | a team                           |
| `provider`        | an LLM provider                  |
| `model`           | a specific model                 |
| `llm_secret_name` | a specific LLM credential        |
| `host_ref`        | an agent (host)                  |
| `context_ref`     | a context                        |
| `source_kind`     | e.g. `workflow`                  |
| `recipe_name`     | a workflow recipe               |
| `cron_job_id`     | a cron job                       |

So per-user, per-team, per-provider, per-model, per-agent, per-recipe, per-cron,
and global budgets are all expressible.

## 5. LLM prices — deriving cost from tokens

A budget's **unit is EITHER `tokens` OR `cost`** — not both. `unit = 'cost'`
requires a `currency` (enforced by both zod and a DB CHECK).

- **Tokens budget.** Spend is a raw token count with no price JOIN:
  `SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens)`
  over the period rollups.
- **Cost budget.** Spend is per-`(provider, model)` token sums multiplied by the
  active `llm_model_prices` rates. Unpriced `(provider, model)` pairs count as
  **$0** and are surfaced (logged as `budget_unpriced_usage`) but never denied.

**How prices are keyed and stored:**

- Prices are keyed by `(provider, model)`, with **one enabled row per pair**
  (partial unique index `idx_llm_model_prices_active … WHERE enabled`).
- Each row carries four per-token-class prices: `input_token_price`,
  `output_token_price`, `cache_read_token_price`, `cache_write_token_price`.
- Prices are expressed **per 1,000,000 tokens** (per 1M), stored as `NUMERIC`
  for monetary precision. Cost is computed as:

  ```
  amount = (input_tokens*input_token_price
          + output_tokens*output_token_price
          + cache_read_tokens*cache_read_token_price
          + cache_write_tokens*cache_write_token_price) / 1e6
  ```

- Currency is a per-row `TEXT` column defaulting to `USD`; seeded values are USD
  per 1M tokens. Price fields validate as finite numbers `>= 0`; cache prices
  default to `0`.

Spend is period-aligned, stitching `usage_daily` (whole past days) and
`usage_5min` (today), with period bounds computed in Postgres via
`date_trunc … AT TIME ZONE`.

**Period & timezone.** A budget has a `period` (`daily` / `weekly` / `monthly`)
and a `timezone` column, but only **`UTC`** is accepted in this version.

## 6. Managing budgets

### Admin API

Both routers are mounted under the admin router at `/api/v1/admin`.

**LLM prices** (`/api/v1/admin/llm-prices`):

| Method + path                        | Behavior                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `GET /admin/llm-prices`              | List all prices (`{ rows }`)                                                     |
| `GET /admin/llm-prices/unpriced`     | Distinct `(provider, model)` pairs seen in usage with no active price row       |
| `GET /admin/llm-prices/:id`          | Fetch one by UUID (404 on non-UUID or missing)                                  |
| `POST /admin/llm-prices`             | Create (201; 400 zod; 409 on duplicate active provider/model)                   |
| `PUT /admin/llm-prices/:id`          | Update (409 `price_in_use_by_budget` if disabling/re-keying a pinned price)     |
| `DELETE /admin/llm-prices/:id`       | Delete (204; 409 `price_in_use_by_budget` if still pinned by a cost budget)     |

**Budgets** (`/api/v1/admin/budgets`):

| Method + path                | Behavior                                                                    |
| ---------------------------- | --------------------------------------------------------------------------- |
| `GET /admin/budgets`         | List, each with live computed `spent`/`remaining` (`{ rows }`)              |
| `GET /admin/budgets/:id`     | Fetch one with computed spend (404 on non-UUID or missing)                  |
| `POST /admin/budgets`        | Create (201; 400 `unpriced_models`; 400 `invalid_request`)                  |
| `PUT /admin/budgets/:id`     | Update (200; 400 on unpriced/validation errors)                             |
| `PATCH /admin/budgets/:id`   | Quick `enabled` toggle                                                       |
| `DELETE /admin/budgets/:id`  | Delete (204)                                                                 |

### Control UI

The sidebar section is labeled exactly **Cost & Usage** (links to
`/cost/usage`). The surface has three tabs, in order:

1. **Usage** — `/cost/usage`
2. **LLM Prices** — `/cost/llm-prices`
3. **Token Budgets** — `/cost/token-budgets`

On **Token Budgets**, admins can:

- View budgets in a table with columns: Name, Scope, Unit, Period, Spent /
  Limit (live progress bar, with an "over" state), Mode (enforcement), Enabled,
  Actions.
- Create a budget (**New budget** button), edit (pencil), delete (X), and toggle
  enabled/disabled by clicking the badge.
- Search/filter by name, unit, period, and scope text; refresh.

The **budget form** (create/edit) sets:

- **Budget:** Name (required), Unit (Cost / Tokens), Limit amount (> 0), and
  Currency (shown and required only when unit is cost, default USD).
- **Period:** Period (Daily / Weekly / Monthly, default monthly) and Timezone
  (read-only, pinned to UTC).
- **Thresholds:** Min remaining to start (>= 0, default 0), Max per task
  (optional, > 0 or blank), Enforcement (**Warn** default / **Block**), and an
  Enabled checkbox (default true).
- **Scope:** pin to Provider, Model (free-text with suggestions), Team, User,
  Agent (`host_ref`), Secret (`llm_secret_name`) — dimensions ANDed, values
  ORed, empty scope = global.

For cost budgets, the form shows a live **unpriced-model** warning derived from
loaded prices and links to **LLM Prices** to add them; a server
`400 unpriced_models` rejection blocks the save with a banner.

## 7. Gotchas

- **Cost enforcement needs prices.** A cost budget can only enforce against
  `(provider, model)` pairs that have an **enabled** price row. Unpriced usage
  counts as $0 — it is surfaced/logged but **never denied**, so a cost budget
  will silently under-count until you add the missing prices. Creating a cost
  budget that pins unpriced models is rejected with `400 unpriced_models`.
- **Spend lags ~1–2 minutes.** There is no live counter; spend is computed from
  usage rollups. Bursts of concurrent tasks are guarded only by the danger-zone
  reservation, not by real-time accounting.
- **Off by default.** `CLERUM_BUDGETS_ENABLED` is `false` unless set (the
  minikube overlay sets it `true`). With it off, all checks pass.
- **Fail-open by design.** A control-api outage never blocks a task. Budgets
  control cost; they are not a security boundary.
- **`warn` never denies.** In observation mode a budget only logs
  `budget_would_block`; you must set enforcement to `block` for it to stop
  traffic.
- **Only UTC.** The timezone column exists but only `UTC` is accepted in this
  version.

---

License: MPL-2.0
