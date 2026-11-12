/**
 * The regex rules of a workbook: the work they may do is counted, so a busy
 * host applies the same rules as an idle one, and one hostile pattern stops
 * the regex rules after it instead of holding the host.
 */
import { describe, expect, it } from 'vitest'
import { RegexBudget } from '../xlsxRules'

describe('RegexBudget', () => {
  it('tests rules until the characters they would scan pass the budget, whatever the load', () => {
    const budget = new RegexBudget(100)
    const texts = ['FAIL-1', 'ok-2', 'FAIL-3'] // 19 characters, a separator after each
    for (let i = 0; i < 5; i++) expect(budget.run('^FAIL-', texts)).toEqual([true, false, true])
    expect(budget.run('^FAIL-', texts)).toEqual({ reason: 'budget', characters: 100 })
  })

  it('skips the rules after one that runs out of time', () => {
    const budget = new RegexBudget(1_000_000, 50)
    const started = performance.now()
    expect(budget.run('^(a|a)*$', [`${'a'.repeat(40)}!`])).toEqual({ reason: 'timeout', ms: 50 })
    expect(budget.run('^a', ['a'])).toEqual({ reason: 'after-timeout' })
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('reports a pattern the matcher refuses as an error, not as slow', () => {
    const result = new RegexBudget().run('[', ['a'])
    expect(result).toMatchObject({ reason: 'error' })
  })
})
