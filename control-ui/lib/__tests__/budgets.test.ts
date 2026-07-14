import { describe, expect, it } from 'vitest'
import {
  budgetProgressPercent,
  enforcementLabel,
  formatBudgetAmount,
  formatBudgetScope,
  isGlobalScope,
} from '../budgets'

describe('enforcementLabel', () => {
  it('maps known enforcement modes to display labels', () => {
    expect(enforcementLabel('block')).toBe('Block')
    expect(enforcementLabel('warn')).toBe('Warn')
  })

  it('falls back to the raw value for an unknown mode', () => {
    // @ts-expect-error exercising the runtime fallback for an out-of-enum value
    expect(enforcementLabel('observe')).toBe('observe')
  })
})

describe('formatBudgetScope', () => {
  it('returns an empty list for a global ({}) scope', () => {
    expect(formatBudgetScope({})).toEqual([])
    expect(isGlobalScope({})).toBe(true)
    expect(isGlobalScope(null)).toBe(true)
  })

  it('renders dimension labels and resolves provider/team/user values', () => {
    const segments = formatBudgetScope(
      { provider: ['openai'], team_id: ['t1'], user_id: ['u1'] },
      { team: { t1: 'Acme' }, user: { u1: 'ada@example.com' } }
    )
    const byKey = Object.fromEntries(segments.map(s => [s.key, s]))
    expect(byKey.provider.label).toBe('Provider')
    expect(byKey.provider.values).toEqual(['OpenAI'])
    expect(byKey.team_id.label).toBe('Team')
    expect(byKey.team_id.values).toEqual(['Acme'])
    expect(byKey.user_id.values).toEqual(['ada@example.com'])
  })

  it('falls back to the raw id when no lookup label exists', () => {
    const segments = formatBudgetScope({ team_id: ['missing'] })
    expect(segments[0].values).toEqual(['missing'])
  })

  it('skips empty value arrays', () => {
    expect(formatBudgetScope({ provider: [] })).toEqual([])
  })

  it('orders known dimensions before unknown ones', () => {
    const segments = formatBudgetScope({ source_kind: ['cron'], provider: ['openai'] })
    expect(segments.map(s => s.key)).toEqual(['provider', 'source_kind'])
  })
})

describe('formatBudgetAmount', () => {
  it('formats cost amounts with the budget currency', () => {
    expect(formatBudgetAmount(12.5, 'cost', 'USD')).toContain('12.5')
    expect(formatBudgetAmount(12.5, 'cost', 'USD')).toMatch(/\$|USD/)
  })

  it('falls back to "<code> <number>" for an unknown currency code', () => {
    expect(formatBudgetAmount(10, 'cost', 'NOTACURRENCY')).toBe('NOTACURRENCY 10')
  })

  it('formats token amounts as grouped integers', () => {
    expect(formatBudgetAmount(1500000, 'tokens')).toBe((1500000).toLocaleString())
  })
})

describe('budgetProgressPercent', () => {
  it('computes a clamped percentage', () => {
    expect(budgetProgressPercent(25, 100)).toBe(25)
    expect(budgetProgressPercent(150, 100)).toBe(100)
    expect(budgetProgressPercent(-5, 100)).toBe(0)
  })

  it('returns 0 for a non-positive or invalid limit', () => {
    expect(budgetProgressPercent(10, 0)).toBe(0)
    expect(budgetProgressPercent(10, Number.NaN)).toBe(0)
  })
})
