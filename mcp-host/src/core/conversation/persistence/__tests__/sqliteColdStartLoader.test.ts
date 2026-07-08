/**
 * SqliteColdStartLoader — B7 regression tests.
 *
 * Covers:
 *   - TTL filter: approvals whose `expires_at` is in the past are dropped
 *     and `onExpired` fires.
 *   - Probe completeness: refs in `completed_results` (not just
 *     `context_snapshot`) are probed, so an expired blob there causes the
 *     approval to be dropped before `resumeAfterApproval` would explode.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SpilloverResolver } from '../../../orchestration/spilloverResolver'
import type { ToolResult } from '../../../types'
import type { ConversationStore, PersistedSessionListing } from '../../conversationStore'
import { SqliteColdStartLoader } from '../sqliteColdStartLoader'

function makeListing(opts: {
  requestId: string
  expiresAt?: number
  contextRefs?: string[]
  completedRefs?: string[]
}): PersistedSessionListing {
  const ctx = (opts.contextRefs ?? []).map(ref => ({
    role: 'tool' as const,
    content: '[spilled]',
    spillover_ref: ref,
  }))
  const completed = (opts.completedRefs ?? []).map(
    (ref): ToolResult => ({
      tool_call_id: `tc-${ref}`,
      name: 'shell_exec',
      content: '[spilled]',
      is_error: false,
      spillover_ref: ref,
    })
  )
  return {
    sessionKey: `s-${opts.requestId}`,
    approval: {
      request_id: opts.requestId,
      tool_name: 'shell_exec',
      parameters: {},
      description: 'test',
      tool_call_id: `tc-${opts.requestId}`,
      context_snapshot: ctx,
      completed_results: completed,
    },
    taskId: `t-${opts.requestId}`,
    expiresAt: opts.expiresAt,
  }
}

function fakeStore(listings: PersistedSessionListing[]): {
  store: ConversationStore
  unpinned: string[]
} {
  const unpinned: string[] = []
  const store = {
    loadAllPendingApprovals: async () => listings,
    // releaseDropped() consults get() (to flip state → Idle) and unpin() to
    // free the leaked pinned slot. A conforming ConversationStore always has
    // these; the fake records the unpin so tests can assert the release.
    get: () => undefined,
    unpin: (key: string) => {
      unpinned.push(key)
    },
  } as unknown as ConversationStore
  return { store, unpinned }
}

describe('SqliteColdStartLoader — B7 TTL + probe completeness', () => {
  it('B7a — drops approvals whose expires_at is in the past and notifies onExpired', async () => {
    const past = Date.now() - 60_000
    const future = Date.now() + 60_000
    const listings = [
      makeListing({ requestId: 'expired', expiresAt: past }),
      makeListing({ requestId: 'fresh', expiresAt: future }),
    ]
    const onExpired = vi.fn()
    const { store, unpinned } = fakeStore(listings)
    const loader = new SqliteColdStartLoader(store, { onExpired })

    const result = await loader.loadPendingApprovals(Date.now())

    expect(result.map(r => r.request_id)).toEqual(['fresh'])
    expect(onExpired).toHaveBeenCalledTimes(1)
    expect(onExpired.mock.calls[0]![0].request_id).toBe('expired')
    // The dropped session must be unpinned so its pinned LRU slot is reclaimed.
    expect(unpinned).toEqual(['s-expired'])
  })

  it('B7b — probes refs in completed_results, not just context_snapshot', async () => {
    // The approval has a fresh ref in context_snapshot but an expired ref
    // in completed_results. Pre-B7 the loader only inspected
    // context_snapshot → the approval would be rehydrated and explode at
    // resumeAfterApproval. After the fix, completed_results refs are probed
    // too and the approval is dropped cleanly.
    const future = Date.now() + 60_000
    const listings = [
      makeListing({
        requestId: 'mixed-refs',
        expiresAt: future,
        contextRefs: ['fresh-ctx'],
        completedRefs: ['expired-completed'],
      }),
    ]
    const resolver: SpilloverResolver = {
      resolve: async m => m.content,
      probe: async refs => ({
        alive: refs.filter(r => r === 'fresh-ctx'),
        expired: refs.filter(r => r === 'expired-completed'),
      }),
    }
    const onExpired = vi.fn()
    const { store, unpinned } = fakeStore(listings)
    const loader = new SqliteColdStartLoader(store, {
      spilloverResolver: resolver,
      onExpired,
    })

    const result = await loader.loadPendingApprovals(Date.now())

    expect(result).toHaveLength(0)
    expect(onExpired).toHaveBeenCalledTimes(1)
    expect(onExpired.mock.calls[0]![0].request_id).toBe('mixed-refs')
    expect(unpinned).toEqual(['s-mixed-refs'])
  })

  it('passes through approvals whose refs are all alive', async () => {
    const future = Date.now() + 60_000
    const listings = [
      makeListing({
        requestId: 'all-alive',
        expiresAt: future,
        contextRefs: ['ctx-1'],
        completedRefs: ['comp-1'],
      }),
    ]
    const resolver: SpilloverResolver = {
      resolve: async m => m.content,
      probe: async refs => ({ alive: refs, expired: [] }),
    }
    const { store, unpinned } = fakeStore(listings)
    const loader = new SqliteColdStartLoader(store, { spilloverResolver: resolver })

    const result = await loader.loadPendingApprovals(Date.now())

    expect(result).toHaveLength(1)
    expect(result[0].request_id).toBe('all-alive')
    // Nothing dropped → nothing unpinned.
    expect(unpinned).toEqual([])
  })
})
