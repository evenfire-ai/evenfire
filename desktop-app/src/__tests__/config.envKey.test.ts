import { beforeEach, describe, expect, it, vi } from 'vitest'

// resolveEnvKey is pure, but importing config.ts touches the Electron `app`
// object at module load, so provide a minimal mock.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/evenfire-test-userdata'),
    isPackaged: false,
    isReady: vi.fn(() => true),
    setName: vi.fn(),
    setPath: vi.fn(),
  },
}))

let resolveEnvKey: (url: string) => string

beforeEach(async () => {
  const mod = await import('../config.js')
  resolveEnvKey = mod.resolveEnvKey
})

describe('resolveEnvKey (spec §5.1, D1)', () => {
  it('is deterministic and stable across calls for the same origin', () => {
    const a = resolveEnvKey('https://example.com')
    const b = resolveEnvKey('https://example.com')
    expect(a).toBe(b)
  })

  it('is filesystem/keychain-safe (no scheme separators, slashes, or colons)', () => {
    const key = resolveEnvKey('https://example.com:8091')
    expect(key).not.toMatch(/[/\\:]/)
    expect(key).toMatch(/^[a-z0-9_]+-[0-9a-f]{12}$/)
  })

  it('keys distinct origins apart — dev vs prod (D1 subdomain case)', () => {
    expect(resolveEnvKey('https://example.com')).not.toBe(resolveEnvKey('https://example.com'))
  })

  it('keys apart on scheme and port (origin includes both)', () => {
    expect(resolveEnvKey('http://api.example.com')).not.toBe(
      resolveEnvKey('https://api.example.com')
    )
    expect(resolveEnvKey('https://api.example.com:8091')).not.toBe(
      resolveEnvKey('https://api.example.com:8092')
    )
  })

  it('ignores path/query (same origin ⇒ same key)', () => {
    expect(resolveEnvKey('https://api.example.com/rpc?x=1')).toBe(
      resolveEnvKey('https://api.example.com')
    )
  })

  it('produces a valid, stable key for the Localhost sentinel origin', () => {
    const key = resolveEnvKey('http://127.0.0.1:8091')
    expect(key).toMatch(/^http_127_0_0_1_8091-[0-9a-f]{12}$/)
    expect(resolveEnvKey('http://127.0.0.1:8091')).toBe(key)
  })

  it('does not throw on an invalid URL (falls back to a stable key)', () => {
    expect(() => resolveEnvKey('not a url')).not.toThrow()
    expect(resolveEnvKey('not a url')).toBe(resolveEnvKey('not a url'))
  })
})
