// test/services.registryClientMachineCreds.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetTokenCacheForTests, mintToken } from '../src/services/registryClient.js'

const { cfg } = vi.hoisted(() => ({
  cfg: {
    registryConnectionMode: 'self-hosted',
    registryUrl: 'https://registry.evenfire.ai',
    registryClientId: '',
    registryClientSecret: '',
    registryAuthEnabled: true,
  } as Record<string, unknown>,
}))
vi.mock('../src/config.js', () => ({ config: cfg }))

// Task 7: mintToken() now also calls isRegistryAuthActive() to derive
// authEnabled (replacing the CLERUM_REGISTRY_AUTH_ENABLED env read). This is
// a whole-module mock, so isRegistryAuthActive must be included here too —
// otherwise it is undefined on the mocked module and mintToken's `await
// isRegistryAuthActive()` throws a TypeError in both tests below.
const resolver = vi.hoisted(() => ({
  resolveMachineCreds: vi.fn(),
  isRegistryAuthActive: vi.fn(),
}))
vi.mock('../src/services/registryConnectionDb.js', () => resolver)

afterEach(() => {
  __resetTokenCacheForTests()
  vi.restoreAllMocks()
  cfg.registryConnectionMode = 'self-hosted'
  cfg.registryAuthEnabled = true
})

describe('mintToken — self-hosted sources creds from the DB row', () => {
  it('uses resolveMachineCreds() and posts client_credentials with them', async () => {
    resolver.resolveMachineCreds.mockResolvedValue({
      clientId: 'db-id',
      clientSecret: 'db-secret',
    })
    // Mirrors the real self-hosted isRegistryAuthActive(): creds resolved → active.
    resolver.isRegistryAuthActive.mockResolvedValue(true)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'tok', expires_in: 300 }), { status: 200 })
      )
    const tok = await mintToken()
    expect(tok).toBe('tok')
    const [, init] = fetchSpy.mock.calls[0]
    const auth = (init as RequestInit).headers as Record<string, string>
    expect(auth.Authorization).toBe(`Basic ${Buffer.from('db-id:db-secret').toString('base64')}`)
  })

  it('returns "" (auth-off) when no creds are resolvable and auth is disabled', async () => {
    cfg.registryAuthEnabled = false
    resolver.resolveMachineCreds.mockResolvedValue(null)
    // Mirrors the real self-hosted isRegistryAuthActive(): no creds → inactive.
    resolver.isRegistryAuthActive.mockResolvedValue(false)
    expect(await mintToken()).toBe('')
  })
})
