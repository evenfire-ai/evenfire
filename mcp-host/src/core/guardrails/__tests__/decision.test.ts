/**
 * Decision algebra tests (spec §3). The algebra is pure + fully implemented in
 * Phase 1, so this is real coverage — not a skeleton.
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateDecision,
  atLeastAsStrict,
  pickPresentationReason,
  stricter,
  unmatchedDefault,
} from '../decision'
import type { Contributor, Decision } from '../types'

function c(
  decision: Decision,
  source: Contributor<unknown, unknown>['source'],
  sourceId: string,
  reasonCode: string
): Contributor<unknown, unknown> {
  return { phase: 'pre', source, sourceId, decision, reasonCode }
}

describe('strictness order (deny > ask > allow > no_decision)', () => {
  it('ranks stricter() correctly', () => {
    expect(stricter('allow', 'deny')).toBe('deny')
    expect(stricter('ask', 'allow')).toBe('ask')
    expect(stricter('no_decision', 'allow')).toBe('allow')
    expect(stricter('deny', 'ask')).toBe('deny')
  })

  it('atLeastAsStrict() is a total order', () => {
    expect(atLeastAsStrict('deny', 'ask')).toBe(true)
    expect(atLeastAsStrict('allow', 'ask')).toBe(false)
    expect(atLeastAsStrict('allow', 'allow')).toBe(true)
  })
})

describe('aggregateDecision', () => {
  it('empty set → no_decision', () => {
    expect(aggregateDecision([])).toBe('no_decision')
  })

  it('returns the strictest contribution regardless of array order', () => {
    const contribs = [
      c('allow', 'host_rule', 'a', 'ok'),
      c('deny', 'host_rule', 'b', 'blocked'),
      c('ask', 'host_rule', 'c', 'confirm'),
    ]
    expect(aggregateDecision(contribs)).toBe('deny')
    expect(aggregateDecision([...contribs].reverse())).toBe('deny')
  })

  it('a single allow does not override a deny', () => {
    expect(
      aggregateDecision([c('deny', 'admin_rule', 'x', 'r'), c('allow', 'hook', 'y', 'r')])
    ).toBe('deny')
  })
})

describe('unmatchedDefault (spec §3)', () => {
  it('non-empty rule set → ask; absent → no_decision', () => {
    expect(unmatchedDefault(true)).toBe('ask')
    expect(unmatchedDefault(false)).toBe('no_decision')
  })
})

describe('pickPresentationReason (tie-break — presentation only)', () => {
  it('prefers admin_rule over hook/host_rule for the winning decision', () => {
    const contribs = [
      c('deny', 'host_rule', 'h', 'host_reason'),
      c('deny', 'admin_rule', 'a', 'admin_reason'),
      c('allow', 'hook', 'z', 'ignored'),
    ]
    expect(pickPresentationReason(contribs, 'deny')).toBe('admin_reason')
  })

  it('breaks ties within a source by lexical sourceId', () => {
    const contribs = [c('deny', 'hook', 'b', 'reason_b'), c('deny', 'hook', 'a', 'reason_a')]
    expect(pickPresentationReason(contribs, 'deny')).toBe('reason_a')
  })

  it('returns undefined when no contribution carries the decision', () => {
    expect(pickPresentationReason([c('allow', 'hook', 'a', 'r')], 'deny')).toBeUndefined()
  })
})
