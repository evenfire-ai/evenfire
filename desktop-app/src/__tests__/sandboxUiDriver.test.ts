import { describe, expect, it, vi } from 'vitest'
import {
  SANDBOX_UI_COOKIE_NAME,
  applySandboxUiClientRoute,
  canApplySandboxUiClientRoute,
  extractSandboxUiCookie,
  extractSandboxUiPath,
  partitionFor,
  reloadSandboxUiWebContents,
} from '../sandboxUiDriver.js'

describe('applySandboxUiClientRoute', () => {
  it('hands a nested route to the loaded app without requesting it from the server', async () => {
    const executeJavaScript = vi.fn().mockResolvedValue(true)

    const applied = await applySandboxUiClientRoute(
      { isDestroyed: () => false, executeJavaScript },
      'https://rpc.example/api/v1/sandbox-ui/sandbox-recipes/task-board/view/tasks/task-42'
    )

    expect(applied).toBe(true)
    expect(executeJavaScript).toHaveBeenCalledOnce()
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain('window.history.replaceState')
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain("PopStateEvent('popstate'")
  })

  it('does not hand off a route to a destroyed app view', async () => {
    const executeJavaScript = vi.fn()

    await expect(
      applySandboxUiClientRoute(
        { isDestroyed: () => true, executeJavaScript },
        'https://rpc.example'
      )
    ).resolves.toBe(false)
    expect(executeJavaScript).not.toHaveBeenCalled()
  })
})

describe('canApplySandboxUiClientRoute', () => {
  const expectedUrl = 'https://rpc.example/api/v1/sandbox-ui/ns/app/view/'

  it('waits through a 503 interstitial before handing off the client route', () => {
    expect(
      canApplySandboxUiClientRoute({
        expectedUrl,
        currentUrl: expectedUrl,
        navigatedUrl: expectedUrl,
        httpResponseCode: 503,
      })
    ).toBe(false)
  })

  it('accepts only a successful load of the expected server route', () => {
    expect(
      canApplySandboxUiClientRoute({
        expectedUrl,
        currentUrl: expectedUrl,
        navigatedUrl: expectedUrl,
        httpResponseCode: 200,
      })
    ).toBe(true)
    expect(
      canApplySandboxUiClientRoute({
        expectedUrl,
        currentUrl: `${expectedUrl}unexpected`,
        navigatedUrl: expectedUrl,
        httpResponseCode: 200,
      })
    ).toBe(false)
  })
})

describe('partitionFor', () => {
  it('produces a stable persist:sandbox-ui partition name per (env, recipe)', () => {
    expect(partitionFor('env1', 'sandbox-recipes', 'r1')).toBe(
      'persist:sandbox-ui-env1-sandbox-recipes-r1'
    )
  })

  it('keeps recipe A and recipe B in distinct partitions (storage isolation)', () => {
    expect(partitionFor('env1', 'sandbox-recipes', 'a')).not.toBe(
      partitionFor('env1', 'sandbox-recipes', 'b')
    )
  })

  it('keeps the same recipe in distinct partitions across environments (spec §5.2)', () => {
    expect(partitionFor('envA', 'sandbox-recipes', 'r1')).not.toBe(
      partitionFor('envB', 'sandbox-recipes', 'r1')
    )
  })
})

describe('extractSandboxUiCookie', () => {
  it('reads the cookie value from a single Set-Cookie header', () => {
    const header = `${SANDBOX_UI_COOKIE_NAME}=abc.def.ghi; Path=/api/v1/sandbox-ui/sandbox-recipes/r1/; HttpOnly; SameSite=Strict; Max-Age=300`
    expect(extractSandboxUiCookie(header)).toBe('abc.def.ghi')
  })

  it('handles an array of Set-Cookie headers (Node getSetCookie shape)', () => {
    expect(
      extractSandboxUiCookie([
        'unrelated=xyz; Path=/',
        `${SANDBOX_UI_COOKIE_NAME}=tok.value; Path=/api/v1/sandbox-ui/sandbox-recipes/r1/`,
      ])
    ).toBe('tok.value')
  })

  it('returns null when the named cookie is absent', () => {
    expect(extractSandboxUiCookie('other=value; Path=/')).toBeNull()
  })

  it('returns null on an empty array', () => {
    expect(extractSandboxUiCookie([])).toBeNull()
  })

  it('preserves the value verbatim (no decoding) — the JWT is opaque to the client', () => {
    const header = `${SANDBOX_UI_COOKIE_NAME}=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig; Path=/`
    expect(extractSandboxUiCookie(header)).toBe('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig')
  })
})

describe('extractSandboxUiPath', () => {
  it('reads the Path attribute from the Set-Cookie header', () => {
    const header = `${SANDBOX_UI_COOKIE_NAME}=tok; Path=/api/v1/sandbox-ui/sandbox-recipes/r1/; HttpOnly`
    expect(extractSandboxUiPath(header, 'sandbox-recipes', 'r1')).toBe(
      '/api/v1/sandbox-ui/sandbox-recipes/r1/'
    )
  })

  it('falls back to the canonical per-recipe path when Path is absent', () => {
    const header = `${SANDBOX_UI_COOKIE_NAME}=tok; HttpOnly; SameSite=Strict`
    expect(extractSandboxUiPath(header, 'sandbox-recipes', 'r1')).toBe(
      '/api/v1/sandbox-ui/sandbox-recipes/r1/'
    )
  })

  it('percent-encodes ns / name in the fallback so a stray slash cannot widen scope', () => {
    expect(extractSandboxUiPath('', 'weird/ns', 'odd name')).toBe(
      '/api/v1/sandbox-ui/weird%2Fns/odd%20name/'
    )
  })

  it('matches Path case-insensitively (Set-Cookie attribute names are not case-sensitive)', () => {
    const header = `${SANDBOX_UI_COOKIE_NAME}=tok; path=/scoped/; HttpOnly`
    expect(extractSandboxUiPath(header, 'a', 'b')).toBe('/scoped/')
  })
})

describe('reloadSandboxUiWebContents', () => {
  it('hard-reloads a live embed in place (cache-busting so new server data is fetched)', () => {
    const reloadIgnoringCache = vi.fn()
    const webContents = { isDestroyed: () => false, reloadIgnoringCache }

    const reloaded = reloadSandboxUiWebContents(webContents)

    expect(reloaded).toBe(true)
    expect(reloadIgnoringCache).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when nothing is mounted (null webContents) — never throws', () => {
    expect(() => reloadSandboxUiWebContents(null)).not.toThrow()
    expect(reloadSandboxUiWebContents(null)).toBe(false)
    expect(reloadSandboxUiWebContents(undefined)).toBe(false)
  })

  it('skips a torn-down view instead of reloading a destroyed webContents', () => {
    const reloadIgnoringCache = vi.fn()
    const webContents = { isDestroyed: () => true, reloadIgnoringCache }

    const reloaded = reloadSandboxUiWebContents(webContents)

    expect(reloaded).toBe(false)
    expect(reloadIgnoringCache).not.toHaveBeenCalled()
  })
})
