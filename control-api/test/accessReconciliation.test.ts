import { describe, expect, it, vi } from 'vitest'
import type { K8sGateway } from '../src/k8s.js'
import {
  DeletedAgentHistoryLimitError,
  MAX_DELETED_ACCESS_HISTORY,
  accessValueSetsEqual,
  buildAgentDirectoryEntry,
  filterAccessValues,
  listActiveAgentNames,
  mergeActiveAgentUpdateWithDeletedHistory,
  mergeActiveUpdateWithDeletedHistory,
  normalizeUnique,
} from '../src/services/directory/accessReconciliation.js'

describe('access reconciliation helpers', () => {
  it('normalizes and filters access values through a shared helper', () => {
    expect(normalizeUnique([' ctx-a ', '', 'ctx-a', 'ctx-b'])).toEqual(['ctx-a', 'ctx-b'])
    expect(filterAccessValues(['ctx-a', 'ctx-old', 'ctx-a'], new Set(['ctx-a']))).toEqual(['ctx-a'])
  })

  it('caps retained deleted grant history and drops names that became active again', () => {
    const deletedHistory = Array.from(
      { length: MAX_DELETED_ACCESS_HISTORY + 5 },
      (_value, index) => `deleted-${index}`
    )
    const merged = mergeActiveUpdateWithDeletedHistory(
      ['active-a', 'deleted-1', 'stale-submit'],
      ['active-a', 'deleted-1'],
      deletedHistory
    )

    expect(merged).toHaveLength(MAX_DELETED_ACCESS_HISTORY + 2)
    expect(merged.slice(0, 2)).toEqual(['active-a', 'deleted-1'])
    expect(merged).not.toContain('stale-submit')
    expect(merged.at(-1)).toBe(`deleted-${MAX_DELETED_ACCESS_HISTORY}`)
    expect(merged).not.toContain(`deleted-${MAX_DELETED_ACCESS_HISTORY + 1}`)
  })

  it('compares complete snapshots as normalized sets', () => {
    expect(accessValueSetsEqual([' agent-a ', 'agent-b', 'agent-a'], ['agent-b', 'agent-a'])).toBe(
      true
    )
    expect(accessValueSetsEqual(['agent-a'], ['agent-b'])).toBe(false)
  })

  it('builds the opaque subject from trusted metadata, never display text', () => {
    expect(
      buildAgentDirectoryEntry(
        {
          metadata: { name: 'trading-agent', namespace: 'mcp-host' },
          spec: { enabled: true, host: 'Trading Agent / Europe' },
        },
        'mcp-host'
      )
    ).toEqual({
      name: 'trading-agent',
      namespace: 'mcp-host',
      displayName: 'Trading Agent / Europe',
      active: true,
      gfsSubject: { type: 'host', id: '1st:mcp-host/trading-agent' },
    })
  })

  it('excludes disabled, deleted, malformed, non-first-party, and legacy sentinel hosts', () => {
    const hosts = [
      { metadata: { name: 'visible', namespace: 'mcp-host' }, spec: { host: 'Visible' } },
      { metadata: { name: 'disabled', namespace: 'mcp-host' }, spec: { enabled: false } },
      {
        metadata: {
          name: 'deleted',
          namespace: 'mcp-host',
          deletionTimestamp: '2026-07-17T12:00:00Z',
        },
        spec: {},
      },
      { metadata: { name: '../invalid', namespace: 'mcp-host' }, spec: {} },
      { metadata: { name: ' padded ', namespace: 'mcp-host' }, spec: {} },
      { metadata: { name: 'missing-namespace' }, spec: {} },
      { metadata: { name: 'third-party', namespace: 'sandbox-recipes' }, spec: {} },
      { metadata: { name: 'standalone', namespace: 'mcp-host' }, spec: {} },
    ]

    const entries = hosts
      .map(host => buildAgentDirectoryEntry(host, 'mcp-host'))
      .filter(entry => entry !== null)
    expect(entries).toEqual([
      {
        name: 'visible',
        namespace: 'mcp-host',
        displayName: 'Visible',
        active: true,
        gfsSubject: { type: 'host', id: '1st:mcp-host/visible' },
      },
    ])
  })

  it('keeps standalone as an individual Host outside the reserved mcp-host namespace', () => {
    expect(
      buildAgentDirectoryEntry(
        { metadata: { name: 'standalone', namespace: 'custom-hosts' }, spec: {} },
        'custom-hosts'
      )
    ).toEqual({
      name: 'standalone',
      namespace: 'custom-hosts',
      displayName: 'standalone',
      active: true,
      gfsSubject: { type: 'host', id: '1st:custom-hosts/standalone' },
    })
  })

  it('lists only the canonical active trusted first-party Host names in source order', async () => {
    const listResource = vi.fn().mockResolvedValue([
      { metadata: { name: 'active-b', namespace: 'mcp-host' }, spec: { enabled: true } },
      { metadata: { name: 'disabled', namespace: 'mcp-host' }, spec: { enabled: false } },
      {
        metadata: {
          name: 'deleting',
          namespace: 'mcp-host',
          deletionTimestamp: '2026-07-18T00:00:00Z',
        },
        spec: {},
      },
      { metadata: { name: '../malformed', namespace: 'mcp-host' }, spec: {} },
      { metadata: { name: 'wrong-namespace', namespace: 'sandbox-recipes' }, spec: {} },
      { metadata: { name: 'standalone', namespace: 'mcp-host' }, spec: {} },
      { metadata: { name: 'active-a', namespace: 'mcp-host' }, spec: {} },
      { metadata: { name: 'active-b', namespace: 'mcp-host' }, spec: {} },
    ])
    const gateway = { listResource } as unknown as K8sGateway

    await expect(listActiveAgentNames(gateway)).resolves.toEqual(['active-b', 'active-a'])
    expect(listResource).toHaveBeenCalledOnce()
    expect(listResource).toHaveBeenCalledWith('hosts', 'mcp-host')
  })

  it('preserves every deleted agent at the limit and rejects overflow without truncation', () => {
    const atLimit = Array.from(
      { length: MAX_DELETED_ACCESS_HISTORY },
      (_value, index) => `deleted-${index}`
    )

    expect(mergeActiveAgentUpdateWithDeletedHistory(['active-a'], ['active-a'], atLimit)).toEqual([
      'active-a',
      ...atLimit,
    ])
    expect(() =>
      mergeActiveAgentUpdateWithDeletedHistory(
        ['active-a'],
        ['active-a'],
        [...atLimit, 'deleted-over-limit']
      )
    ).toThrow(DeletedAgentHistoryLimitError)
  })
})
