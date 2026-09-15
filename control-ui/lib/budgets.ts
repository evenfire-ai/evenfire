// Shared formatting helpers for token budgets (token-budgets P0c, spec §6.2).
// Keeps the human-readable scope rendering and amount formatting in one place
// so the list table, the form, and tests stay in sync.
import type { BudgetEnforcement, BudgetPeriod, BudgetScope, BudgetUnit } from './api'
import { getProviderDisplayLabel } from './llm'

// Dimensions the P0c scope editor surfaces, in display order. The server allows
// more (context_ref, source_kind, recipe_name, cron_job_id); those are omitted
// from the editor for now but still rendered if present on an existing budget.
export const BUDGET_SCOPE_DIMENSION_KEYS = [
  'provider',
  'model',
  'team_id',
  'user_id',
  'host_ref',
  'llm_secret_name',
] as const

export type BudgetScopeDimensionKey = (typeof BUDGET_SCOPE_DIMENSION_KEYS)[number]

// Human labels for every server dimension, so an unknown-to-the-editor key
// (e.g. an existing budget scoped on source_kind) still renders readably.
export const BUDGET_DIMENSION_LABELS: Record<string, string> = {
  provider: 'Provider',
  model: 'Model',
  team_id: 'Team',
  user_id: 'User',
  host_ref: 'Agent',
  llm_secret_name: 'Secret',
  context_ref: 'Connector scope',
  source_kind: 'Source',
  recipe_name: 'Recipe',
  cron_job_id: 'Cron job',
}

export function dimensionLabel(key: string): string {
  return BUDGET_DIMENSION_LABELS[key] ?? key
}

// id → display-name maps so opaque UUIDs (team_id, user_id) render as names.
export type BudgetScopeLookups = {
  team?: Record<string, string>
  user?: Record<string, string>
}

export function formatScopeValue(key: string, value: string, lookups?: BudgetScopeLookups): string {
  if (key === 'provider') return getProviderDisplayLabel(value)
  if (key === 'team_id') return lookups?.team?.[value] ?? value
  if (key === 'user_id') return lookups?.user?.[value] ?? value
  return value
}

export type BudgetScopeSegment = { key: string; label: string; values: string[] }

/**
 * Turn a budget's JSONB scope into ordered, human-readable segments. `{}` (no
 * keys) yields an empty array — the caller renders that as "Global".
 */
export function formatBudgetScope(
  scope: BudgetScope | null | undefined,
  lookups?: BudgetScopeLookups
): BudgetScopeSegment[] {
  if (!scope || typeof scope !== 'object') return []
  const keys = Object.keys(scope)
  // Stable, editor-first ordering: known dimensions first, then any extras.
  keys.sort((a, b) => {
    const ia = (BUDGET_SCOPE_DIMENSION_KEYS as readonly string[]).indexOf(a)
    const ib = (BUDGET_SCOPE_DIMENSION_KEYS as readonly string[]).indexOf(b)
    const ra = ia === -1 ? Number.MAX_SAFE_INTEGER : ia
    const rb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib
    return ra === rb ? a.localeCompare(b) : ra - rb
  })
  const segments: BudgetScopeSegment[] = []
  for (const key of keys) {
    const values = scope[key]
    if (!Array.isArray(values) || values.length === 0) continue
    segments.push({
      key,
      label: dimensionLabel(key),
      values: values.map(value => formatScopeValue(key, value, lookups)),
    })
  }
  return segments
}

export function isGlobalScope(scope: BudgetScope | null | undefined): boolean {
  return formatBudgetScope(scope).length === 0
}

/**
 * Format a budget amount in its own unit: a currency string for `cost`, a
 * grouped integer for `tokens`.
 */
export function formatBudgetAmount(
  value: number,
  unit: BudgetUnit,
  currency?: string | null
): string {
  if (!Number.isFinite(value)) return '-'
  if (unit === 'cost') {
    const code = (currency ?? '').trim() || 'USD'
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: code,
        maximumFractionDigits: 4,
      }).format(value)
    } catch {
      // Unknown ISO currency code → fall back to "<code> <number>".
      return `${code} ${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`.trim()
    }
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export const BUDGET_PERIOD_LABELS: Record<BudgetPeriod, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
}

export function periodLabel(period: BudgetPeriod): string {
  return BUDGET_PERIOD_LABELS[period] ?? period
}

// Enforcement mode display: `block` denies tasks over the limit, `warn` only
// observes (P0c default). Surfaced in the list so an admin can tell at a glance
// whether an "over" row is denying or just watching.
export const BUDGET_ENFORCEMENT_LABELS: Record<BudgetEnforcement, string> = {
  block: 'Block',
  warn: 'Warn',
}

export function enforcementLabel(enforcement: BudgetEnforcement): string {
  return BUDGET_ENFORCEMENT_LABELS[enforcement] ?? enforcement
}

/** spent/limit as a 0–100 percentage, clamped. Returns 0 for a non-positive limit. */
export function budgetProgressPercent(spent: number, limit: number): number {
  if (!Number.isFinite(spent) || !Number.isFinite(limit) || limit <= 0) return 0
  const pct = (spent / limit) * 100
  if (pct < 0) return 0
  if (pct > 100) return 100
  return pct
}
