import { afterEach, describe, expect, it, vi } from 'vitest'

const TTL = 'CLERUM_ATTACHMENT_STORE_TTL_HOURS'
const SESSION = 'CLERUM_ATTACHMENT_STORE_SESSION_MAX_BYTES'
const HOST = 'CLERUM_ATTACHMENT_STORE_HOST_MAX_BYTES'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function load() {
  vi.resetModules()
  return (await import('./config')).config
}

describe('attachment retention configuration', () => {
  it('defaults to seven days, 64 MiB per session and 1 GiB per Host', async () => {
    vi.stubEnv(TTL, undefined)
    vi.stubEnv(SESSION, undefined)
    vi.stubEnv(HOST, undefined)
    const config = await load()
    expect(config).toMatchObject({
      attachmentStoreTtlMs: 604_800_000,
      attachmentStoreSessionMaxBytes: 67_108_864,
      attachmentStoreHostMaxBytes: 1_073_741_824,
    })
  })

  it.each([TTL, SESSION, HOST])('rejects invalid %s instead of using its default', async key => {
    for (const value of ['', '0', '-1', '1.5', '1e6', '12hours', 'Infinity', '9007199254740992']) {
      vi.stubEnv(key, value)
      await expect(load()).rejects.toThrow(key)
    }
  })

  it('accepts explicitly configured limits without changing the upload limit', async () => {
    vi.stubEnv(TTL, '24')
    vi.stubEnv(SESSION, '12582912')
    vi.stubEnv(HOST, '33554432')
    const config = await load()
    expect(config).toMatchObject({
      attachmentStoreTtlMs: 86_400_000,
      attachmentStoreSessionMaxBytes: 12_582_912,
      attachmentStoreHostMaxBytes: 33_554_432,
      attachmentFileMaxBytes: 11_534_336,
    })
  })

  it('rejects a session cap greater than the Host cap', async () => {
    vi.stubEnv(SESSION, '67108864')
    vi.stubEnv(HOST, '33554432')
    await expect(load()).rejects.toThrow(SESSION)
  })

  it('requires space for one admitted file and honors a smaller configured file limit', async () => {
    vi.stubEnv(SESSION, '11534335')
    await expect(load()).rejects.toThrow(SESSION)
    vi.stubEnv('CLERUM_ATTACHMENT_FILE_MAX_BYTES', '3145728')
    vi.stubEnv(SESSION, '3145728')
    vi.stubEnv(HOST, '3145728')
    expect(await load()).toMatchObject({
      attachmentStoreSessionMaxBytes: 3_145_728,
      attachmentStoreHostMaxBytes: 3_145_728,
    })
  })

  it('rejects a TTL that cannot produce a valid absolute JavaScript date', async () => {
    vi.stubEnv(TTL, '2400000000')
    await expect(load()).rejects.toThrow(TTL)
  })
})
