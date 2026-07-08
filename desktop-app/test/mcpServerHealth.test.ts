import { describe, expect, it } from 'vitest'
import {
  FAST_POLL_INTERVAL_MS,
  MAX_CONCURRENT_POLLERS,
  MCP_INIT_AUTH_FAILED_MESSAGE,
  MCP_NOT_READY_MESSAGE,
  POLL_INTERVAL_MS,
  STALE_AFTER_MS,
  classifyRowLabel,
  hasConnectingRow,
  isStale,
  mergeAgentHealth,
  mergeCatalogHealth,
  nextPollIntervalMs,
} from '../src/mcpServerHealth'
import type {
  AgentWithMcpServers,
  HostRuntimeStatus,
  McpServerHealthRow,
  McpServerState,
} from '../src/types'

const NOW = Date.parse('2026-04-21T18:00:00.000Z')
const freshly = new Date(NOW - 1_000).toISOString()
const longAgo = new Date(NOW - STALE_AFTER_MS - 1_000).toISOString()

function row(
  overrides: Partial<McpServerHealthRow> & { name: string; state: McpServerState }
): McpServerHealthRow {
  return {
    expected: true,
    toolCount: 1,
    reason: null,
    message: null,
    observedAt: freshly,
    ...overrides,
  }
}

function agent(
  name: string,
  servers: string[],
  contextRef: string | null = 'ctx'
): AgentWithMcpServers {
  return { name, contextRef, mcpServers: servers.map(n => ({ name: n })) }
}

function status(hostRef: string, mcpServers?: McpServerHealthRow[]): HostRuntimeStatus {
  return {
    hostRef,
    agent: {
      state: 'idle',
      currentTaskId: null,
      tasksProcessed: 0,
      tasksSucceeded: 0,
      tasksFailed: 0,
      uptime: 0,
    },
    queue: { pending: 0, processing: 0, completed: 0, failed: 0 },
    cronJobs: 0,
    pendingApprovalsCount: 0,
    observedAt: freshly,
    ...(mcpServers ? { mcpServers } : {}),
  }
}

describe('constants line up with the spec', () => {
  it('STALE_AFTER_MS is 2 × POLL_INTERVAL_MS', () => {
    expect(STALE_AFTER_MS).toBe(2 * POLL_INTERVAL_MS)
  })
  it('FAST_POLL_INTERVAL_MS < POLL_INTERVAL_MS', () => {
    expect(FAST_POLL_INTERVAL_MS).toBeLessThan(POLL_INTERVAL_MS)
  })
  it('MAX_CONCURRENT_POLLERS is a small positive integer', () => {
    expect(MAX_CONCURRENT_POLLERS).toBeGreaterThan(0)
    expect(Number.isInteger(MAX_CONCURRENT_POLLERS)).toBe(true)
  })
  it('exports the exact mcp-host failure strings for E2E parity', () => {
    expect(MCP_INIT_AUTH_FAILED_MESSAGE).toBe('initialize returned 401')
    expect(MCP_NOT_READY_MESSAGE).toBe('control plane reported server not ready')
  })
})

describe('isStale', () => {
  it('returns false when observedAt is within the threshold', () => {
    expect(isStale(freshly, NOW)).toBe(false)
  })
  it('returns true when observedAt is older than STALE_AFTER_MS', () => {
    expect(isStale(longAgo, NOW)).toBe(true)
  })
  it('returns true for unparseable timestamps', () => {
    expect(isStale('not-a-date', NOW)).toBe(true)
  })
  it('accepts a custom threshold', () => {
    const ts = new Date(NOW - 10_000).toISOString()
    expect(isStale(ts, NOW, 5_000)).toBe(true)
    expect(isStale(ts, NOW, 20_000)).toBe(false)
  })
})

describe('classifyRowLabel', () => {
  it("connected + toolCount>0 → 'running'", () => {
    expect(classifyRowLabel(row({ name: 'a', state: 'connected', toolCount: 3 }), NOW)).toBe(
      'running'
    )
  })

  it("connected + toolCount==0 → 'degraded'", () => {
    expect(classifyRowLabel(row({ name: 'a', state: 'connected', toolCount: 0 }), NOW)).toBe(
      'degraded'
    )
  })

  it("failed → 'failed'", () => {
    expect(
      classifyRowLabel(
        row({ name: 'a', state: 'failed', reason: 'auth_failed', message: 'x' }),
        NOW
      )
    ).toBe('failed')
  })

  it("connecting → 'starting'", () => {
    expect(classifyRowLabel(row({ name: 'a', state: 'connecting' }), NOW)).toBe('starting')
  })

  it("disabled → 'disabled' (operator intent never goes stale)", () => {
    expect(classifyRowLabel(row({ name: 'a', state: 'disabled', observedAt: longAgo }), NOW)).toBe(
      'disabled'
    )
  })

  it('unknown state short-circuits before the stale check', () => {
    // unknown is already the caller's "no data yet" label; don't promote to stale.
    expect(classifyRowLabel(row({ name: 'a', state: 'unknown', observedAt: longAgo }), NOW)).toBe(
      'unknown'
    )
  })

  it("any non-disabled, non-unknown stale row → 'stale'", () => {
    expect(
      classifyRowLabel(
        row({ name: 'a', state: 'connected', toolCount: 3, observedAt: longAgo }),
        NOW
      )
    ).toBe('stale')
    expect(
      classifyRowLabel(
        row({ name: 'a', state: 'failed', reason: 'timeout', message: 't', observedAt: longAgo }),
        NOW
      )
    ).toBe('stale')
    expect(
      classifyRowLabel(row({ name: 'a', state: 'connecting', observedAt: longAgo }), NOW)
    ).toBe('stale')
  })
})

describe('mergeAgentHealth', () => {
  it('binds catalog names to matching RPC rows', () => {
    const a = agent('trader', ['mcp-a', 'mcp-b'])
    const s = status('trader', [
      row({ name: 'mcp-a', state: 'connected', toolCount: 3 }),
      row({
        name: 'mcp-b',
        state: 'failed',
        reason: 'auth_failed',
        message: MCP_INIT_AUTH_FAILED_MESSAGE,
        toolCount: 0,
      }),
    ])
    const t = mergeAgentHealth(a, s, NOW)
    expect(t.rows).toHaveLength(2)
    expect(t.rows[0].label).toBe('running')
    expect(t.rows[1].label).toBe('failed')
    expect(t.rows[1].message).toBe(MCP_INIT_AUTH_FAILED_MESSAGE)
    expect(t.unknownFallback).toBe(false)
  })

  it('synthesizes an unknown row when the catalog name is absent from RPC', () => {
    const a = agent('trader', ['mcp-a', 'mcp-b'])
    const s = status('trader', [row({ name: 'mcp-a', state: 'connected', toolCount: 3 })])
    const t = mergeAgentHealth(a, s, NOW)
    expect(t.rows[1].name).toBe('mcp-b')
    expect(t.rows[1].state).toBe('unknown')
    expect(t.rows[1].label).toBe('unknown')
  })

  it('ignores RPC rows that are not in the catalog (spec §5 default)', () => {
    const a = agent('trader', ['mcp-a'])
    const s = status('trader', [
      row({ name: 'mcp-a', state: 'connected', toolCount: 1 }),
      row({ name: 'rogue', state: 'connected', toolCount: 99 }),
    ])
    const t = mergeAgentHealth(a, s, NOW)
    expect(t.rows.map(r => r.name)).toEqual(['mcp-a'])
  })

  it('flags unknownFallback=true when status is absent (old/missing upstream)', () => {
    const a = agent('trader', ['mcp-a'])
    const t = mergeAgentHealth(a, null, NOW)
    expect(t.unknownFallback).toBe(true)
    expect(t.rows[0].label).toBe('unknown')
  })

  it('flags unknownFallback=true when status omits mcpServers (old mcp-host)', () => {
    const a = agent('trader', ['mcp-a'])
    const s = status('trader') // no mcpServers field
    const t = mergeAgentHealth(a, s, NOW)
    expect(t.unknownFallback).toBe(true)
    expect(t.rows[0].label).toBe('unknown')
  })

  it('emits label=stale for catalog rows whose matching RPC row has aged out', () => {
    const a = agent('trader', ['mcp-a'])
    const s = status('trader', [
      row({ name: 'mcp-a', state: 'connected', toolCount: 2, observedAt: longAgo }),
    ])
    const t = mergeAgentHealth(a, s, NOW)
    expect(t.rows[0].label).toBe('stale')
    expect(t.rows[0].stale).toBe(true)
  })

  it('preserves catalog order regardless of RPC row order', () => {
    const a = agent('trader', ['mcp-a', 'mcp-b', 'mcp-c'])
    const s = status('trader', [
      row({ name: 'mcp-c', state: 'connected', toolCount: 1 }),
      row({ name: 'mcp-a', state: 'connected', toolCount: 1 }),
      row({ name: 'mcp-b', state: 'connected', toolCount: 1 }),
    ])
    const t = mergeAgentHealth(a, s, NOW)
    expect(t.rows.map(r => r.name)).toEqual(['mcp-a', 'mcp-b', 'mcp-c'])
  })
})

describe('mergeCatalogHealth', () => {
  it('produces one table per catalog agent, in catalog order', () => {
    const agents = [agent('a1', ['s1']), agent('a2', ['s2'])]
    const byHost = new Map<string, HostRuntimeStatus | null | undefined>([
      ['a1', status('a1', [row({ name: 's1', state: 'connected', toolCount: 1 })])],
      [
        'a2',
        status('a2', [
          row({ name: 's2', state: 'failed', reason: 'timeout', message: 'x', toolCount: 0 }),
        ]),
      ],
    ])
    const out = mergeCatalogHealth(agents, byHost, NOW)
    expect(out.map(t => t.hostRef)).toEqual(['a1', 'a2'])
    expect(out[0].rows[0].label).toBe('running')
    expect(out[1].rows[0].label).toBe('failed')
  })

  it('applies the unknown fallback per agent independently', () => {
    const agents = [agent('a1', ['s1']), agent('a2', ['s2'])]
    const byHost = new Map<string, HostRuntimeStatus | null | undefined>([
      ['a1', status('a1', [row({ name: 's1', state: 'connected', toolCount: 1 })])],
      // a2 has no status entry
    ])
    const out = mergeCatalogHealth(agents, byHost, NOW)
    expect(out[0].unknownFallback).toBe(false)
    expect(out[1].unknownFallback).toBe(true)
  })
})

describe('hasConnectingRow / nextPollIntervalMs', () => {
  it('fast-polls while any row is starting', () => {
    const agents = [agent('a1', ['s1'])]
    const byHost = new Map<string, HostRuntimeStatus>([
      ['a1', status('a1', [row({ name: 's1', state: 'connecting' })])],
    ])
    const tables = mergeCatalogHealth(agents, byHost, NOW)
    expect(hasConnectingRow(tables)).toBe(true)
    expect(nextPollIntervalMs(tables)).toBe(FAST_POLL_INTERVAL_MS)
  })

  it('steady-state polling once nothing is starting', () => {
    const agents = [agent('a1', ['s1'])]
    const byHost = new Map<string, HostRuntimeStatus>([
      ['a1', status('a1', [row({ name: 's1', state: 'connected', toolCount: 2 })])],
    ])
    const tables = mergeCatalogHealth(agents, byHost, NOW)
    expect(hasConnectingRow(tables)).toBe(false)
    expect(nextPollIntervalMs(tables)).toBe(POLL_INTERVAL_MS)
  })
})

describe('acceptance scenarios (pinned by spec §9)', () => {
  it('#1 — CoinGecko 401 renders as failed + auth_failed + exact message', () => {
    const a = agent('trader', ['mcp-coingecko-remote'])
    const s = status('trader', [
      row({
        name: 'mcp-coingecko-remote',
        state: 'failed',
        reason: 'auth_failed',
        message: MCP_INIT_AUTH_FAILED_MESSAGE,
        toolCount: 0,
      }),
    ])
    const t = mergeAgentHealth(a, s, NOW)
    expect(t.rows[0].label).toBe('failed')
    expect(t.rows[0].reason).toBe('auth_failed')
    expect(t.rows[0].message).toBe(MCP_INIT_AUTH_FAILED_MESSAGE)
  })

  it('#2 — handshake OK, zero tools → degraded (not running)', () => {
    const a = agent('trader', ['mcp-empty'])
    const s = status('trader', [row({ name: 'mcp-empty', state: 'connected', toolCount: 0 })])
    const t = mergeAgentHealth(a, s, NOW)
    expect(t.rows[0].label).toBe('degraded')
  })

  it('#4 — old mcp-host (no mcpServers field) → unknown rows, no empty-list regression', () => {
    const a = agent('trader', ['mcp-a', 'mcp-b'])
    const s = status('trader') // no mcpServers field
    const t = mergeAgentHealth(a, s, NOW)
    expect(t.unknownFallback).toBe(true)
    expect(t.rows.map(r => r.label)).toEqual(['unknown', 'unknown'])
  })
})
