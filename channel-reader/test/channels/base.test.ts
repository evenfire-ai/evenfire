import { describe, expect, it } from 'vitest'
import { isAllowedSender, isInlineApprovalCommand } from '../../src/channels/base.js'

describe('isInlineApprovalCommand', () => {
  it('accepts /approve, /approve always, and /deny with trim and case folding', () => {
    expect(isInlineApprovalCommand('/approve')).toBe(true)
    expect(isInlineApprovalCommand('  /APPROVE  ')).toBe(true)
    expect(isInlineApprovalCommand('/approve always')).toBe(true)
    expect(isInlineApprovalCommand('\t/Approve Always\n')).toBe(true)
    expect(isInlineApprovalCommand('/deny')).toBe(true)
    expect(isInlineApprovalCommand('/DENY ')).toBe(true)
    expect(isInlineApprovalCommand('/approve due-diligence-review')).toBe(true)
    expect(isInlineApprovalCommand('/deny due-diligence-review')).toBe(true)
    expect(isInlineApprovalCommand('/approve team.daily-report')).toBe(true)
  })

  it('rejects suffixed or partial commands', () => {
    expect(isInlineApprovalCommand('/approve 00000000-0000-0000-0000-000000000111')).toBe(false)
    expect(isInlineApprovalCommand('/deny 00000000-0000-0000-0000-000000000111')).toBe(false)
    expect(isInlineApprovalCommand('/approved')).toBe(false)
    expect(isInlineApprovalCommand('approve')).toBe(false)
    expect(isInlineApprovalCommand('/approve always later')).toBe(false)
    expect(isInlineApprovalCommand('/deny always')).toBe(false)
    expect(isInlineApprovalCommand('/approve due_diligence')).toBe(false)
    expect(isInlineApprovalCommand('/approve .daily-report')).toBe(false)
    expect(isInlineApprovalCommand('/approve daily-report.')).toBe(false)
    expect(isInlineApprovalCommand('/approve\nalways')).toBe(false)
  })
})

describe('isAllowedSender', () => {
  it('matches case-insensitively and ignores leading @', () => {
    expect(isAllowedSender('Alice', new Set(['alice']))).toBe(true)
    expect(isAllowedSender('@Bob', new Set(['bob']))).toBe(true)
    expect(isAllowedSender('eve', new Set(['@EVE']))).toBe(true)
  })

  it('returns false when sender is not in the set', () => {
    expect(isAllowedSender('mallory', new Set(['alice']))).toBe(false)
  })
})
