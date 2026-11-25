import { describe, expect, it } from 'vitest'
import { channelTableRows } from '@lib/approvalChannels'
import type {
  ApprovalChannelTarget,
  WorkflowApprovalMediumAccount,
} from '@/app/types/approvalChannels'
import producerOutput from '@/test/fixtures/telegram-channel-accounts.json'

const wire = producerOutput as unknown as {
  targets: ApprovalChannelTarget[]
  twoAccounts: WorkflowApprovalMediumAccount[]
  sharedAccount: WorkflowApprovalMediumAccount[]
}

describe('Channel inventory from the real Telegram association producer', () => {
  it('keeps both confirmed chats on one target actionable', () => {
    expect(wire.twoAccounts.every(account => account.targets?.length === 1)).toBe(true)
    const rows = channelTableRows(wire.targets.slice(0, 1), wire.twoAccounts)
    expect(rows.flatMap(row => (row.account ? [row.account.id] : [])).sort()).toEqual([
      'account-1',
      'account-2',
    ])
  })

  it('represents an account bound to two targets only once', () => {
    expect(wire.sharedAccount[0]!.targets).toHaveLength(2)
    const rows = channelTableRows(wire.targets, wire.sharedAccount)
    expect(rows.flatMap(row => (row.account ? [row.account.id] : []))).toEqual(['account-1'])
    expect(rows.filter(row => row.target).map(row => row.status)).toEqual(['Verified', 'Verified'])
  })

  it('preserves every target and account exactly once across 10000 inventory combinations', () => {
    let seed = 1538
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
    for (let trial = 0; trial < 10000; trial++) {
      const targets = wire.targets.filter(() => next() % 3 !== 0)
      const accounts = Array.from({ length: next() % 6 }, (_, index) => ({
        ...wire.sharedAccount[0]!,
        id: `account-${index}`,
        targets: wire.targets.filter(() => next() % 3 !== 0),
      }))
      const rows = channelTableRows(targets, accounts)
      expect(rows.flatMap(row => (row.account ? [row.account.id] : [])).sort()).toEqual(
        accounts.map(account => account.id).sort()
      )
      expect(rows.flatMap(row => (row.target ? [row.target.id] : [])).sort()).toEqual(
        targets.map(target => target.id).sort()
      )
      expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
      expect(channelTableRows(targets, accounts)).toEqual(rows)
    }
  })
})
