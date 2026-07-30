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

const resolver = vi.hoisted(() => ({
  resolveMachineCreds: vi.fn(),
}))
vi.mock('../src/services/registryConnectionDb.js', () => resolver)

afterEach(() => {
  __resetTokenCacheForTests()
  vi.restoreAllMocks()
  cfg.registryConnectionMode = 'self-hosted'
  cfg.registryAuthEnabled = true
  delete process.env.CLERUM_REGISTRY_CLIENT_ID
  delete process.env.CLERUM_REGISTRY_CLIENT_SECRET
})

describe('mintToken — self-hosted sources creds from the DB row', () => {
  it('uses resolveMachineCreds() and posts client_credentials with them', async () => {
    resolver.resolveMachineCreds.mockResolvedValue({
      clientId: 'db-id',
      clientSecret: 'db-secret',
    })
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
    expect(await mintToken()).toBe('')
  })

  it('ignores stale env credentials and authenticates with the self-hosted DB identity', async () => {
    process.env.CLERUM_REGISTRY_CLIENT_ID = 'stale-managed-id'
    process.env.CLERUM_REGISTRY_CLIENT_SECRET = 'stale-managed-secret'
    resolver.resolveMachineCreds.mockResolvedValue({
      clientId: 'db-id',
      clientSecret: 'db-secret',
    })
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'tok', expires_in: 300 }), { status: 200 })
      )

    await mintToken()

    const [, init] = fetchSpy.mock.calls[0]
    const auth = (init as RequestInit).headers as Record<string, string>
    expect(auth.Authorization).toBe(`Basic ${Buffer.from('db-id:db-secret').toString('base64')}`)
    expect(auth.Authorization).not.toContain(
      Buffer.from('stale-managed-id:stale-managed-secret').toString('base64')
    )
  })

  it('does not authenticate from stale env credentials before the DB connection exists', async () => {
    process.env.CLERUM_REGISTRY_CLIENT_ID = 'stale-managed-id'
    process.env.CLERUM_REGISTRY_CLIENT_SECRET = 'stale-managed-secret'
    resolver.resolveMachineCreds.mockResolvedValue(null)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(mintToken()).resolves.toBe('')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
