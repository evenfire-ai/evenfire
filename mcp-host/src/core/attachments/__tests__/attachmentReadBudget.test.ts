import { describe, expect, it } from 'vitest'
import {
  AttachmentReadLedger,
  attachmentReadBudgets,
  mergeAttachmentReadLedgerSnapshots,
  readAttachmentReadLedgerSnapshot,
} from '../attachmentReadBudget'

const zero = { reads: 0, spentTokens: 0, bytesRead: 0 }

describe('notice overdraft', () => {
  const WINDOW = 10_000 // page 1000, turn 3000, ceiling 4500

  it('charges a notice past the turn up to half a turn more, without reads or bytes', () => {
    const ledger = new AttachmentReadLedger()
    ledger.restore({ reads: 32, spentTokens: 3_000, bytesRead: 77 })
    expect(ledger.canEmit(WINDOW, 100)).toBe(false)
    expect(ledger.debitNotice(WINDOW, 1_000)).toBe(true)
    expect(ledger.debitNotice(WINDOW, 500)).toBe(true)
    expect(ledger.snapshot()).toEqual({ reads: 32, spentTokens: 4_500, bytesRead: 77 })
  })

  it('reports the ceiling with false and leaves the ledger unchanged', () => {
    const ledger = new AttachmentReadLedger()
    ledger.restore({ reads: 32, spentTokens: 4_400, bytesRead: 77 })
    // Witness: the last 100 tokens of overdraft are still charged.
    expect(ledger.debitNotice(WINDOW, 100)).toBe(true)
    expect(ledger.snapshot().spentTokens).toBe(4_500)
    expect(ledger.debitNotice(WINDOW, 1)).toBe(false)
    expect(ledger.snapshot()).toEqual({ reads: 32, spentTokens: 4_500, bytesRead: 77 })
  })

  it('refuses a notice larger than one page even with overdraft left', () => {
    const ledger = new AttachmentReadLedger()
    ledger.restore({ reads: 0, spentTokens: 3_000, bytesRead: 0 })
    expect(() => ledger.debitNotice(WINDOW, 1_001)).toThrow(/notice cannot fit/)
    // Witness: a page-sized notice is accepted on the same ledger.
    expect(ledger.debitNotice(WINDOW, 1_000)).toBe(true)
    expect(ledger.snapshot().spentTokens).toBe(4_000)
  })

  it('still throws on an invalid cost or an unsafe spend, at or below the ceiling', () => {
    const ledger = new AttachmentReadLedger()
    ledger.restore({ reads: 0, spentTokens: 3_000, bytesRead: 0 })
    for (const cost of [-1, 1.5, NaN]) {
      expect(() => ledger.debitNotice(WINDOW, cost)).toThrow(/notice cannot fit/)
    }
    expect(ledger.snapshot().spentTokens).toBe(3_000)
    // A spend that is no longer a safe integer is a corrupt ledger, not a ceiling.
    const huge = 1_000_000_000_000
    ledger.restore({ reads: 0, spentTokens: Number.MAX_SAFE_INTEGER - 10, bytesRead: 0 })
    expect(() => ledger.debitNotice(huge, 100)).toThrow(/notice cannot fit/)
    // Witness: a valid cost on the same ledger is answered, not thrown.
    ledger.restore({ reads: 0, spentTokens: 3_000, bytesRead: 0 })
    expect(ledger.debitNotice(WINDOW, 10)).toBe(true)
  })
})

describe('attachment turn ledger', () => {
  it('derives the 10% page and 30% turn limits', () => {
    expect(attachmentReadBudgets(10_000)).toEqual({ pageTokens: 1_000, turnTokens: 3_000 })
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => attachmentReadBudgets(value)).toThrow()
    }
  })
  it('limits calls to 32 and reserves complete-message notices', () => {
    const ledger = new AttachmentReadLedger()
    // 33 notices of 80 tokens exceed half of the 3_000-token turn, so the
    // reserve is capped at floor(1_500 / 80) = 18 notices; the page cap binds.
    expect(ledger.pageAllowance(10_000, 80)).toBe(1_000)
    ledger.restore({ reads: 0, spentTokens: 1_000, bytesRead: 0 })
    expect(ledger.pageAllowance(10_000, 80)).toBe(3_000 - 1_000 - 18 * 80)
    ledger.reset()
    for (let i = 0; i < 32; i++) expect(ledger.beginRead()).toBe(true)
    expect(ledger.beginRead()).toBe(false)
    expect(ledger.snapshot().reads).toBe(32)
    expect(ledger.pageAllowance(10_000, 80)).toBe(1_000)
  })
  it('leaves a first page on an 8192-token window with a measured 219-token notice', () => {
    const ledger = new AttachmentReadLedger()
    expect(ledger.beginRead()).toBe(true)
    // turn 2_457, reserve min(32, floor(1_228 / 219) = 5) * 219 = 1_095.
    expect(ledger.pageAllowance(8_192, 219)).toBe(819)
  })
  it('never reserves more than half of the turn budget for notices', () => {
    for (const windowTokens of [4_096, 8_192, 16_384, 32_768, 128_000, 1_000_000]) {
      const { pageTokens, turnTokens } = attachmentReadBudgets(windowTokens)
      for (const noticeCost of [1, 80, 219, 339]) {
        if (noticeCost > Math.floor(turnTokens / 2)) continue
        for (const reads of [0, 1, 16, 31, 32]) {
          const ledger = new AttachmentReadLedger()
          ledger.restore({ reads, spentTokens: 0, bytesRead: 0 })
          // At most half of the turn is held back for notices.
          expect(ledger.pageAllowance(windowTokens, noticeCost)).toBeGreaterThanOrEqual(
            Math.min(pageTokens, turnTokens - Math.floor(turnTokens / 2))
          )
          // At least one notice is always held back.
          ledger.restore({ reads, spentTokens: turnTokens - noticeCost, bytesRead: 0 })
          expect(ledger.pageAllowance(windowTokens, noticeCost)).toBe(0)
        }
      }
    }
  })
  it('refuses a window too small to reserve one notice, with a clear message', () => {
    const ledger = new AttachmentReadLedger()
    // turn 30, half 15: a 16-token notice cannot be reserved even once.
    expect(() => ledger.pageAllowance(100, 16)).toThrow(/too small to reserve/i)
    expect(() => ledger.pageAllowance(100, 0)).toThrow(/notice cost/i)
    // Witness: the same window with a notice that fits half the turn returns a page.
    expect(ledger.pageAllowance(100, 15)).toBe(10)
  })
  it('charges successful emissions and refuses an over-budget debit without mutation', () => {
    const ledger = new AttachmentReadLedger()
    expect(() => ledger.debit(10_000, 1_001, 1)).toThrow()
    expect(ledger.snapshot()).toEqual(zero)
    for (let i = 0; i < 3; i++) ledger.debit(10_000, 1_000, 10)
    expect(() => ledger.debit(10_000, 1, 1)).toThrow()
    expect(ledger.snapshot()).toEqual({ reads: 0, spentTokens: 3_000, bytesRead: 30 })
  })
  it('retains actual spend above a smaller window when that window widens', () => {
    const ledger = new AttachmentReadLedger()
    ledger.restore({ reads: 5, spentTokens: 10_000, bytesRead: 40_000 })
    expect(ledger.canEmit(10_000, 1)).toBe(false)
    expect(ledger.canEmit(100_000, 1)).toBe(true)
    expect(ledger.snapshot().spentTokens).toBe(10_000)
  })
  it('exhaustion never lowers existing spend or byte count', () => {
    const ledger = new AttachmentReadLedger()
    ledger.restore({ reads: 5, spentTokens: 10_000, bytesRead: 40_000 })
    ledger.exhaust(10_000)
    expect(ledger.snapshot()).toEqual({ reads: 32, spentTokens: 10_000, bytesRead: 40_000 })
    expect(ledger.beginRead()).toBe(false)
  })
  it('rejects byte-count overflow before debiting tokens', () => {
    const ledger = new AttachmentReadLedger()
    const previous = { reads: 1, spentTokens: 10, bytesRead: Number.MAX_SAFE_INTEGER }
    ledger.restore(previous)
    expect(() => ledger.debit(10_000, 100, 1)).toThrow()
    expect(ledger.snapshot()).toEqual(previous)
  })
  it('rejects a missing counter instead of restoring undefined or zero', () => {
    const ledger = new AttachmentReadLedger()
    expect(() => ledger.restore({ reads: 1, spentTokens: 10 } as never)).toThrow()
    expect(ledger.snapshot()).toEqual(zero)
  })
  it('merges warm snapshots without reducing any spent counter', () => {
    expect(
      mergeAttachmentReadLedgerSnapshots(
        { reads: 12, spentTokens: 4_000, bytesRead: 30_000 },
        { reads: 2, spentTokens: 5_000, bytesRead: 1_000 }
      )
    ).toEqual({ reads: 12, spentTokens: 5_000, bytesRead: 30_000 })
  })
  it('reads persisted zero and over-window counts without clamping', () => {
    expect(readAttachmentReadLedgerSnapshot(zero)).toEqual(zero)
    expect(
      readAttachmentReadLedgerSnapshot({ reads: 32, spentTokens: 1_000_000, bytesRead: 99 })
    ).toEqual({ reads: 32, spentTokens: 1_000_000, bytesRead: 99 })
    for (const value of [
      undefined,
      null,
      {},
      [],
      { reads: 1 },
      { ...zero, reads: 33 },
      { ...zero, spentTokens: -1 },
      { ...zero, bytesRead: 1.5 },
      { ...zero, spentTokens: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(readAttachmentReadLedgerSnapshot(value)).toBeNull()
    }
  })
})
