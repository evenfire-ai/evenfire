// desktop-app/test/e2e/ipc-token.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  E2E_EMAIL,
  E2E_HOST_REF,
  E2E_PASSWORD,
  invoke,
  resetSender,
  setupHarness,
  teardownHarness,
} from './helpers.js'

describe('IPC token and auth e2e', () => {
  beforeAll(async () => {
    await setupHarness()
  })

  afterAll(async () => {
    await teardownHarness()
  })

  // ── Test 17: Unauthenticated call (runs BEFORE login) ───────────
  // Note: ordered first because we need pre-login state
  it('17. invokeHostMessage before login throws Not authenticated', async () => {
    await expect(
      invoke('rpc:invokeHostMessage', {
        hostRef: E2E_HOST_REF,
        payload: { content: 'should fail', channelType: 'rpc', sender: 'e2e-test' },
        hostRefs: [E2E_HOST_REF],
      })
    ).rejects.toThrow('Not authenticated')
  })

  // Login for remaining tests
  it('setup: login', async () => {
    await invoke('auth:passwordLogin', { email: E2E_EMAIL, password: E2E_PASSWORD })
  })

  // ── Test 15: Token metadata ──────────────────────────────────────
  it('15. rpc:getTokenMetadata returns session and RPC token info', async () => {
    // Trigger a host read call first to force RPC token issuance
    await invoke('rpc:getHostStatus', {
      hostRef: E2E_HOST_REF,
      hostRefs: [E2E_HOST_REF],
    })

    const meta = (await invoke('rpc:getTokenMetadata')) as {
      hasSession: boolean
      rpcTokenExpiresAtMs: number | null
      rpcScopes: string[]
      rpcHostRefs: string[]
    }
    expect(meta.hasSession).toBe(true)
    expect(meta.rpcTokenExpiresAtMs).toBeGreaterThan(Date.now())
    expect(Array.isArray(meta.rpcScopes)).toBe(true)
    expect(meta.rpcScopes.length).toBeGreaterThan(0)
  })

  // ── Test 16: Token refresh ───────────────────────────────────────
  it('16. consecutive host reads transparently refresh RPC token', async () => {
    // First call — establishes RPC token
    const status1 = (await invoke('rpc:getHostStatus', {
      hostRef: E2E_HOST_REF,
      hostRefs: [E2E_HOST_REF],
    })) as { hostRef: string }
    expect(status1.hostRef.toLowerCase()).toBe(E2E_HOST_REF.toLowerCase())

    // Second call — should reuse or refresh token transparently
    const status2 = (await invoke('rpc:getHostStatus', {
      hostRef: E2E_HOST_REF,
      hostRefs: [E2E_HOST_REF],
    })) as { hostRef: string }
    expect(status2.hostRef.toLowerCase()).toBe(E2E_HOST_REF.toLowerCase())
  })

  // ── Test 18: Logout ──────────────────────────────────────────────
  it('18. auth:logout clears session, subsequent calls fail', async () => {
    await invoke('auth:logout')

    const state = (await invoke('auth:getSessionState')) as { authenticated: boolean }
    expect(state.authenticated).toBe(false)

    await expect(
      invoke('rpc:getHostStatus', {
        hostRef: E2E_HOST_REF,
        hostRefs: [E2E_HOST_REF],
      })
    ).rejects.toThrow('Not authenticated')
  })
})
