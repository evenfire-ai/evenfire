import { describe, expect, it } from 'vitest'
import {
  MCP_INIT_AUTH_FAILED_MESSAGE,
  MCP_NOT_READY_MESSAGE,
  ServerStatusTracker,
  classifyConnectError,
} from '../serverStatus'

describe('classifyConnectError', () => {
  it('classifies 401 as auth_failed with stable message', () => {
    const r = classifyConnectError({ code: 401 })
    expect(r.reason).toBe('auth_failed')
    expect(r.message).toBe(MCP_INIT_AUTH_FAILED_MESSAGE)
  })

  it('classifies 403 as auth_failed', () => {
    const r = classifyConnectError({ status: 403 })
    expect(r.reason).toBe('auth_failed')
    expect(r.message).toBe('initialize returned 403')
  })

  it('classifies other 4xx as upstream_4xx', () => {
    expect(classifyConnectError({ code: 404 }).reason).toBe('upstream_4xx')
    expect(classifyConnectError({ statusCode: 429 }).reason).toBe('upstream_4xx')
  })

  it('classifies 5xx as upstream_5xx', () => {
    expect(classifyConnectError({ code: 500 }).reason).toBe('upstream_5xx')
    expect(classifyConnectError({ status: 503 }).reason).toBe('upstream_5xx')
  })

  it('classifies ECONNREFUSED / ENOTFOUND / ENETUNREACH as network', () => {
    expect(classifyConnectError({ code: 'ECONNREFUSED', message: 'nope' }).reason).toBe('network')
    expect(classifyConnectError({ code: 'ENOTFOUND' }).reason).toBe('network')
    expect(classifyConnectError({ code: 'ENETUNREACH' }).reason).toBe('network')
  })

  it("classifies ETIMEDOUT and 'timed out' messages as timeout", () => {
    expect(classifyConnectError({ code: 'ETIMEDOUT' }).reason).toBe('timeout')
    expect(classifyConnectError(new Error('request timed out after 5000ms')).reason).toBe('timeout')
  })

  it('classifies jsonrpc / protocol errors as handshake', () => {
    expect(classifyConnectError(new Error('jsonrpc error: invalid params')).reason).toBe(
      'handshake'
    )
    expect(classifyConnectError(new Error('protocol mismatch')).reason).toBe('handshake')
  })

  it('falls back to HTTP-code substring in the message', () => {
    const r = classifyConnectError(new Error('Failed: HTTP 401 Unauthorized'))
    expect(r.reason).toBe('auth_failed')
  })

  it('returns unknown for shapeless errors', () => {
    const r = classifyConnectError({})
    expect(r.reason).toBe('unknown')
    expect(r.message).toBeTruthy()
  })

  it("prefers HTTP status over a 'timeout' word in the same message", () => {
    const r = classifyConnectError({ code: 401, message: 'request timed out' })
    expect(r.reason).toBe('auth_failed')
  })

  it('truncates very long messages', () => {
    const long = 'x'.repeat(1000)
    const r = classifyConnectError(new Error(long))
    expect(r.message.length).toBeLessThanOrEqual(240)
  })
})

describe('ServerStatusTracker transitions', () => {
  const fixedClock = () => new Date('2026-04-21T18:00:00.000Z')

  it('markConnecting creates a new row with state=connecting', () => {
    const t = new ServerStatusTracker(fixedClock)
    t.markConnecting('svc')
    const s = t.get('svc')!
    expect(s.state).toBe('connecting')
    expect(s.expected).toBe(true)
    expect(s.toolCount).toBe(0)
    expect(s.reason).toBeNull()
    expect(s.message).toBeNull()
    expect(s.observedAt).toBe('2026-04-21T18:00:00.000Z')
  })

  it('markConnected transitions from connecting to connected with toolCount', () => {
    const t = new ServerStatusTracker()
    t.markConnecting('svc')
    t.markConnected('svc', 3)
    expect(t.get('svc')!.state).toBe('connected')
    expect(t.get('svc')!.toolCount).toBe(3)
  })

  it('markConnecting is a no-op after markConnected (monotonicity)', () => {
    const t = new ServerStatusTracker()
    t.markConnecting('svc')
    t.markConnected('svc', 2)
    const before = t.get('svc')!
    t.markConnecting('svc')
    const after = t.get('svc')!
    expect(after.state).toBe('connected')
    expect(after.toolCount).toBe(2)
    expect(after.observedAt).toBe(before.observedAt) // no write happened
  })

  it('reset() lets markConnecting transition back to connecting', () => {
    const t = new ServerStatusTracker()
    t.markConnecting('svc')
    t.markConnected('svc', 1)
    t.reset('svc')
    expect(t.get('svc')).toBeUndefined()
    t.markConnecting('svc')
    expect(t.get('svc')!.state).toBe('connecting')
  })

  it('markFailed populates reason and message from the error', () => {
    const t = new ServerStatusTracker()
    t.markConnecting('svc')
    t.markFailed('svc', { code: 401 })
    const s = t.get('svc')!
    expect(s.state).toBe('failed')
    expect(s.reason).toBe('auth_failed')
    expect(s.message).toBe(MCP_INIT_AUTH_FAILED_MESSAGE)
    expect(s.toolCount).toBe(0)
  })

  it('markNotReady yields reason=not_ready (distinct from disabled)', () => {
    const t = new ServerStatusTracker()
    t.markNotReady('svc', 'Deployment 0/1')
    const s = t.get('svc')!
    expect(s.state).toBe('failed')
    expect(s.reason).toBe('not_ready')
    expect(s.message).toBe('Deployment 0/1')
    expect(s.expected).toBe(true)
  })

  it('markNotReady uses default message when none supplied', () => {
    const t = new ServerStatusTracker()
    t.markNotReady('svc')
    expect(t.get('svc')!.message).toBe(MCP_NOT_READY_MESSAGE)
  })

  it('markDisabled sets state=disabled and expected=false (operator intent)', () => {
    const t = new ServerStatusTracker()
    t.markDisabled('svc')
    const s = t.get('svc')!
    expect(s.state).toBe('disabled')
    expect(s.expected).toBe(false)
    expect(s.reason).toBeNull()
  })
})

describe('ServerStatusTracker tool-count and refresh semantics', () => {
  it('updateToolCount is ignored when not connected', () => {
    const t = new ServerStatusTracker()
    t.markConnecting('svc')
    t.updateToolCount('svc', 5)
    expect(t.get('svc')!.toolCount).toBe(0)
  })

  it('updateToolCount clears reason/message on clean refresh', () => {
    const t = new ServerStatusTracker()
    t.markConnecting('svc')
    t.markConnected('svc', 3)
    t.updateToolCount('svc', 3, { refreshError: { code: 500 } })
    expect(t.get('svc')!.reason).toBe('upstream_5xx')
    t.updateToolCount('svc', 3)
    expect(t.get('svc')!.reason).toBeNull()
    expect(t.get('svc')!.message).toBeNull()
  })

  it('refresh failure keeps state=connected but populates reason (§4.5)', () => {
    const t = new ServerStatusTracker()
    t.markConnecting('svc')
    t.markConnected('svc', 3)
    t.updateToolCount('svc', 0, { refreshError: { code: 401 } })
    const s = t.get('svc')!
    expect(s.state).toBe('connected') // NOT failed — monotonic
    expect(s.toolCount).toBe(0) // → UI renders "Degraded"
    expect(s.reason).toBe('auth_failed')
  })

  it('touch updates observedAt without mutating state', () => {
    const clock = (() => {
      let i = 0
      const times = ['2026-04-21T18:00:00.000Z', '2026-04-21T18:00:30.000Z']
      return () => new Date(times[Math.min(i++, times.length - 1)])
    })()
    const t = new ServerStatusTracker(clock)
    t.markConnected('svc', 2)
    const first = t.get('svc')!.observedAt
    t.touch('svc')
    const second = t.get('svc')!.observedAt
    expect(second).not.toBe(first)
    expect(t.get('svc')!.state).toBe('connected')
    expect(t.get('svc')!.toolCount).toBe(2)
  })

  it('touch is a no-op for unknown server', () => {
    const t = new ServerStatusTracker()
    t.touch('ghost')
    expect(t.get('ghost')).toBeUndefined()
  })
})

describe('ServerStatusTracker snapshot and removal', () => {
  it('snapshot returns cloned entries (caller cannot mutate internal state)', () => {
    const t = new ServerStatusTracker()
    t.markConnected('a', 1)
    const snap = t.snapshot()
    snap[0].state = 'failed'
    expect(t.get('a')!.state).toBe('connected')
  })

  it('snapshot includes all tracked servers', () => {
    const t = new ServerStatusTracker()
    t.markConnecting('a')
    t.markConnected('b', 2)
    t.markDisabled('c')
    const names = new Set(t.snapshot().map(e => e.name))
    expect(names).toEqual(new Set(['a', 'b', 'c']))
  })

  it('remove deletes only the named server', () => {
    const t = new ServerStatusTracker()
    t.markConnected('a', 1)
    t.markConnected('b', 1)
    t.remove('a')
    expect(t.get('a')).toBeUndefined()
    expect(t.get('b')!.state).toBe('connected')
  })

  it('reset() with no arg clears everything', () => {
    const t = new ServerStatusTracker()
    t.markConnected('a', 1)
    t.markConnected('b', 1)
    t.reset()
    expect(t.size()).toBe(0)
  })
})
