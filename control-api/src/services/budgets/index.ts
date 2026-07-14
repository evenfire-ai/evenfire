/**
 * Token budgets service (.specs/feat-token-budgets §2.2, §3.1, §3.2, §4.2).
 *
 * - `dimensions`  — scope vocabulary, zod schema, SQL WHERE builder, matcher.
 * - `definitions` — CRUD + zod request schemas + row mapper + errors.
 * - `spend`       — `computeBudgetSpent` (the period-aligned spend core).
 * - `check`       — P1 budget-check evaluation (reuses the three above).
 */
export * from './dimensions.js'
export * from './definitions.js'
export * from './spend.js'
export * from './check.js'
export * from './reservations.js'
