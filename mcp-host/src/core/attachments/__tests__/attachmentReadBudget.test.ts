import { describe, expect, it } from 'vitest'
import {
  AttachmentReadLedger,
  attachmentReadBudgets,
  mergeAttachmentReadLedgerSnapshots,
  readAttachmentReadLedgerSnapshot,
} from '../attachmentReadBudget'

const zero = { reads: 0, spentTokens: 0, bytesRead: 0 }

describe('attachment turn ledger', () => {
  it('derives the 10% page and 30% turn limits', () => {
    expect(attachmentReadBudgets(10_000)).toEqual({ pageTokens: 1_000, turnTokens: 3_000 })
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => attachmentReadBudgets(value)).toThrow()
    }
  })
  it('limits calls to 32 and reserves complete-message notices', () => {
    const ledger = new AttachmentReadLedger()
    expect(ledger.pageAllowance(10_000, 80)).toBe(360)
    for (let i = 0; i < 32; i++) expect(ledger.beginRead()).toBe(true)
    expect(ledger.beginRead()).toBe(false)
    expect(ledger.snapshot().reads).toBe(32)
    expect(ledger.pageAllowance(10_000, 80)).toBe(1_000)
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
