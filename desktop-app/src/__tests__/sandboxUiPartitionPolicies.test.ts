import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  applySandboxUiNavigationPolicies,
  classifyEmbedNavigation,
  parseClerumOauthAuthorize,
  shouldAllowEmbedPermission,
} from '../sandboxUiPartitionPolicies.js'

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }))
vi.mock('electron', () => ({ shell: { openExternal } }))

describe('shouldAllowEmbedPermission', () => {
  it('allows fullscreen', () => {
    expect(shouldAllowEmbedPermission('fullscreen')).toBe(true)
  })

  it.each([
    'media',
    'geolocation',
    'notifications',
    'midiSysex',
    'pointerLock',
    'serial',
    'hid',
    'bluetooth',
    'usb',
  ])('denies %s (spec §11.2 deny list)', name => {
    expect(shouldAllowEmbedPermission(name)).toBe(false)
  })

  it('default-denies any future / unknown permission name', () => {
    // If Electron adds a new permission tomorrow, the embed must NOT
    // get it without an explicit allowlist update.
    expect(shouldAllowEmbedPermission('clipboard-read')).toBe(false)
    expect(shouldAllowEmbedPermission('display-capture')).toBe(false)
    expect(shouldAllowEmbedPermission('something-not-yet-invented')).toBe(false)
    expect(shouldAllowEmbedPermission('')).toBe(false)
  })
})

describe('classifyEmbedNavigation', () => {
  const allowed = 'https://rpc-proxy.example/api/v1/sandbox-ui/sandbox-recipes/r1/view/'

  it('allows URLs that match the recipe view/* prefix exactly', () => {
    expect(classifyEmbedNavigation(allowed, allowed)).toEqual({ kind: 'allow' })
    expect(classifyEmbedNavigation(allowed + 'index.html', allowed)).toEqual({
      kind: 'allow',
    })
    expect(classifyEmbedNavigation(allowed + 'sub/page?x=1', allowed)).toEqual({
      kind: 'allow',
    })
  })

  it('does not allow sibling paths that only share a string prefix', () => {
    const prefixWithoutSlash = allowed.replace(/\/$/, '')
    const sibling = `${prefixWithoutSlash}-other/x`
    expect(classifyEmbedNavigation(sibling, prefixWithoutSlash)).toEqual({
      kind: 'external',
      url: sibling,
    })
    expect(classifyEmbedNavigation(`${prefixWithoutSlash}x/secret`, prefixWithoutSlash)).toEqual({
      kind: 'external',
      url: `${prefixWithoutSlash}x/secret`,
    })
  })

  it('routes a different recipe under the same proxy origin to the OS browser (not allow)', () => {
    // Different recipe — the proxy would 401 it anyway via the JWT
    // claim binding, but the embed should never even attempt to load
    // it inside its own view. Goes to OS browser.
    const otherRecipe = 'https://rpc-proxy.example/api/v1/sandbox-ui/sandbox-recipes/r2/view/'
    expect(classifyEmbedNavigation(otherRecipe, allowed)).toEqual({
      kind: 'external',
      url: otherRecipe,
    })
  })

  it('routes other https URLs to the OS browser', () => {
    expect(classifyEmbedNavigation('https://example.com/', allowed)).toEqual({
      kind: 'external',
      url: 'https://example.com/',
    })
  })

  it('routes plain http URLs to the OS browser too', () => {
    expect(classifyEmbedNavigation('http://example.com/', allowed)).toEqual({
      kind: 'external',
      url: 'http://example.com/',
    })
  })

  it('drops non-http schemes silently (file:, javascript:, data:, etc.)', () => {
    expect(classifyEmbedNavigation('file:///etc/passwd', allowed)).toEqual({
      kind: 'drop',
    })
    expect(classifyEmbedNavigation('javascript:alert(1)', allowed)).toEqual({
      kind: 'drop',
    })
    expect(classifyEmbedNavigation('data:text/html,<h1>x', allowed)).toEqual({
      kind: 'drop',
    })
    expect(classifyEmbedNavigation('chrome://settings', allowed)).toEqual({
      kind: 'drop',
    })
  })

  it('drops empty / undefined-shaped URLs', () => {
    expect(classifyEmbedNavigation('', allowed)).toEqual({ kind: 'drop' })
  })

  it('does NOT allow the bare proxy origin (must include the /view/ suffix)', () => {
    // A navigation to e.g. /api/v1/sandbox-ui/sandbox-recipes/r1/session
    // must NOT load inside the embed; only `view/*` is the document
    // surface.
    const sessionUrl = 'https://rpc-proxy.example/api/v1/sandbox-ui/sandbox-recipes/r1/session'
    expect(classifyEmbedNavigation(sessionUrl, allowed)).toEqual({
      kind: 'external',
      url: sessionUrl,
    })
  })

  describe('clerum: scheme (spec §9.9 OAuth Connect affordance)', () => {
    it('classifies `clerum://oauth?clientId=…` as oauth_authorize', () => {
      expect(classifyEmbedNavigation('clerum://oauth?clientId=salesforce-prod', allowed)).toEqual({
        kind: 'oauth_authorize',
        oauthClientId: 'salesforce-prod',
        background: false,
      })
    })

    it('preserves clientId values with dots, dashes, underscores', () => {
      expect(
        classifyEmbedNavigation('clerum://oauth?clientId=client.id_with-stuff', allowed)
      ).toEqual({
        kind: 'oauth_authorize',
        oauthClientId: 'client.id_with-stuff',
        background: false,
      })
    })

    it('drops a clerum: URL without clientId param', () => {
      expect(classifyEmbedNavigation('clerum://oauth', allowed)).toEqual({ kind: 'drop' })
      expect(classifyEmbedNavigation('clerum://oauth?', allowed)).toEqual({ kind: 'drop' })
      expect(classifyEmbedNavigation('clerum://oauth?clientId=', allowed)).toEqual({
        kind: 'drop',
      })
    })

    it('drops clerum: URLs with the wrong host (oauth-completed must not match here)', () => {
      // `clerum://oauth-completed` is consumed by main process's `open-url`
      // handler, never via embed navigation. The embed driver must drop it
      // so a malicious page cannot replay a completion envelope.
      expect(
        classifyEmbedNavigation('clerum://oauth-completed?clientId=foo&provider=slack', allowed)
      ).toEqual({ kind: 'drop' })
      expect(classifyEmbedNavigation('clerum://anything-else?clientId=foo', allowed)).toEqual({
        kind: 'drop',
      })
    })

    it('drops malformed clerum: URLs', () => {
      expect(classifyEmbedNavigation('clerum:not a url', allowed)).toEqual({ kind: 'drop' })
    })

    it('includes background:true when background=1 is in the URL', () => {
      expect(
        classifyEmbedNavigation('clerum://oauth?clientId=google-gmail&background=1', allowed)
      ).toEqual({ kind: 'oauth_authorize', oauthClientId: 'google-gmail', background: true })
    })

    it('includes background:false when background param is absent', () => {
      expect(classifyEmbedNavigation('clerum://oauth?clientId=google-gmail', allowed)).toEqual({
        kind: 'oauth_authorize',
        oauthClientId: 'google-gmail',
        background: false,
      })
    })
  })
})

describe('parseClerumOauthAuthorize', () => {
  it('returns { oauthClientId, background: true } when background=1', () => {
    expect(parseClerumOauthAuthorize('clerum://oauth?clientId=google-gmail&background=1')).toEqual({
      oauthClientId: 'google-gmail',
      background: true,
    })
  })

  it('returns { oauthClientId, background: false } when background param is absent', () => {
    expect(parseClerumOauthAuthorize('clerum://oauth?clientId=salesforce-prod')).toEqual({
      oauthClientId: 'salesforce-prod',
      background: false,
    })
  })

  it('returns { oauthClientId, background: false } when background=0', () => {
    expect(parseClerumOauthAuthorize('clerum://oauth?clientId=my-client&background=0')).toEqual({
      oauthClientId: 'my-client',
      background: false,
    })
  })

  it('returns null for a URL without clientId', () => {
    expect(parseClerumOauthAuthorize('clerum://oauth')).toBeNull()
  })

  it('returns null for wrong host (oauth-completed)', () => {
    expect(parseClerumOauthAuthorize('clerum://oauth-completed?clientId=foo')).toBeNull()
  })

  it('returns null for malformed URL', () => {
    expect(parseClerumOauthAuthorize('clerum:not a url')).toBeNull()
  })
})

describe('applySandboxUiNavigationPolicies (dispatch wiring)', () => {
  const allowed = 'https://rpc-proxy.example/api/v1/sandbox-ui/sandbox-recipes/r1/view/'

  beforeEach(() => {
    openExternal.mockClear()
  })

  /** A fake WebContents that captures the will-navigate + window-open handlers. */
  function makeWebContents() {
    let willNavigate: ((event: { preventDefault: () => void }, url: string) => void) | undefined
    let windowOpen: ((details: { url: string }) => { action: string }) | undefined
    const wc = {
      on: vi.fn((ev: string, cb: (event: { preventDefault: () => void }, url: string) => void) => {
        if (ev === 'will-navigate') willNavigate = cb
      }),
      setWindowOpenHandler: vi.fn((fn: (details: { url: string }) => { action: string }) => {
        windowOpen = fn
      }),
    } as unknown as WebContents
    return {
      wc,
      navigate(url: string) {
        const event = { preventDefault: vi.fn() }
        willNavigate?.(event, url)
        return event
      },
      openWindow: (url: string) => windowOpen?.({ url }),
    }
  }

  it('fires onOauthAuthorize (with background) and prevents default for a clerum oauth link', () => {
    const onOauthAuthorize = vi.fn()
    const onGfsOpen = vi.fn()
    const fake = makeWebContents()
    applySandboxUiNavigationPolicies(fake.wc, allowed, { onOauthAuthorize, onGfsOpen })

    const event = fake.navigate('clerum://oauth?clientId=salesforce-prod&background=1')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(onOauthAuthorize).toHaveBeenCalledWith('salesforce-prod', true)
    expect(onGfsOpen).not.toHaveBeenCalled()
  })

  it('fires onGfsOpen and prevents default for a gfs:// link', () => {
    const onGfsOpen = vi.fn()
    const fake = makeWebContents()
    applySandboxUiNavigationPolicies(fake.wc, allowed, { onGfsOpen })

    const event = fake.navigate('gfs://main/report.pdf')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(onGfsOpen).toHaveBeenCalledWith('gfs://main/report.pdf')
  })

  it('opens external https navigations in the OS browser', () => {
    const fake = makeWebContents()
    applySandboxUiNavigationPolicies(fake.wc, allowed, {})
    const event = fake.navigate('https://example.com/x')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith('https://example.com/x')
  })

  it('lets an in-prefix view navigation through — no preventDefault, no dispatch', () => {
    const onGfsOpen = vi.fn()
    const onOauthAuthorize = vi.fn()
    const fake = makeWebContents()
    applySandboxUiNavigationPolicies(fake.wc, allowed, { onGfsOpen, onOauthAuthorize })
    const event = fake.navigate(`${allowed}index.html`)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(onGfsOpen).not.toHaveBeenCalled()
    expect(onOauthAuthorize).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('still supports the legacy positional oauth callback', () => {
    const legacyOauth = vi.fn()
    const fake = makeWebContents()
    applySandboxUiNavigationPolicies(fake.wc, allowed, legacyOauth)
    fake.navigate('clerum://oauth?clientId=google-gmail')
    expect(legacyOauth).toHaveBeenCalledWith('google-gmail', false)
  })

  it('dispatches window.open(gfs://…) and denies the popup', () => {
    const onGfsOpen = vi.fn()
    const fake = makeWebContents()
    applySandboxUiNavigationPolicies(fake.wc, allowed, { onGfsOpen })
    const result = fake.openWindow('gfs://main/a.png')
    expect(onGfsOpen).toHaveBeenCalledWith('gfs://main/a.png')
    expect(result).toEqual({ action: 'deny' })
  })

  it('routes window.open(https://…) to the OS browser and denies the popup', () => {
    const fake = makeWebContents()
    applySandboxUiNavigationPolicies(fake.wc, allowed, {})
    const result = fake.openWindow('https://example.com/')
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
    expect(result).toEqual({ action: 'deny' })
  })
})
