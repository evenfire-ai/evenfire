import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _setSandboxUiAuditTarget,
  emitRegistryLookup,
  emitSessionMint,
  emitViewRequest,
} from './sandboxUiAudit.js'

describe('sandbox-ui audit emit', () => {
  let captured: string[]
  let restore: () => void

  beforeEach(() => {
    captured = []
    restore = _setSandboxUiAuditTarget(line => captured.push(line))
  })

  afterEach(() => {
    restore()
  })

  function parsed(): Array<Record<string, unknown>> {
    return captured.map(line => JSON.parse(line) as Record<string, unknown>)
  }

  it('emitSessionMint writes a single JSON line with the canonical fields', () => {
    emitSessionMint({
      outcome: 'ok',
      userId: 'u1',
      recipeNs: 'sandbox-recipes',
      recipeName: 'r1',
    })
    expect(captured).toHaveLength(1)
    const record = parsed()[0]
    expect(record.event).toBe('sandbox_ui_session_mint')
    expect(record.outcome).toBe('ok')
    expect(record.userId).toBe('u1')
    expect(record.recipeNs).toBe('sandbox-recipes')
    expect(record.recipeName).toBe('r1')
    expect(typeof record.ts).toBe('string')
  })

  it('emitSessionMint passes through reason on not_ready outcome', () => {
    emitSessionMint({
      outcome: 'not_ready',
      userId: 'u1',
      recipeNs: 'sandbox-recipes',
      recipeName: 'r1',
      reason: 'phase=deploying',
    })
    const record = parsed()[0]
    expect(record.outcome).toBe('not_ready')
    expect(record.reason).toBe('phase=deploying')
  })

  it('emitViewRequest captures the final response status, method, and path', () => {
    emitViewRequest({
      userId: 'u1',
      recipeNs: 'sandbox-recipes',
      recipeName: 'r1',
      status: 200,
      path: '/dashboard',
      method: 'GET',
    })
    const record = parsed()[0]
    expect(record.event).toBe('sandbox_ui_view_request')
    expect(record.status).toBe(200)
    expect(record.path).toBe('/dashboard')
    expect(record.method).toBe('GET')
  })

  it('emitRegistryLookup tags cacheHit + outcome kind + duration', () => {
    emitRegistryLookup({
      recipeNs: 'sandbox-recipes',
      recipeName: 'r1',
      cacheHit: true,
      kind: 'ok',
      durationMs: 0,
    })
    const record = parsed()[0]
    expect(record.event).toBe('sandbox_ui_registry_lookup')
    expect(record.cacheHit).toBe(true)
    expect(record.kind).toBe('ok')
    expect(record.durationMs).toBe(0)
  })

  it('never includes a cookie field — the cookie token is the secret we are guarding', () => {
    emitSessionMint({
      outcome: 'ok',
      userId: 'u1',
      recipeNs: 'sandbox-recipes',
      recipeName: 'r1',
    })
    emitViewRequest({
      userId: 'u1',
      recipeNs: 'sandbox-recipes',
      recipeName: 'r1',
      status: 200,
      path: '/',
      method: 'GET',
    })
    for (const line of captured) {
      expect(line).not.toContain('cookie')
      expect(line).not.toContain('Cookie')
      expect(line).not.toContain('clerum_sandbox_ui_session')
    }
  })
})
