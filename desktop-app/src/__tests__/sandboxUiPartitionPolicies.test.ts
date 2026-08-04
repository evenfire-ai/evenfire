import { describe, expect, it } from 'vitest'
import {
  classifyEmbedNavigation,
  parseClerumOauthAuthorize,
  shouldAllowEmbedPermission,
} from '../sandboxUiPartitionPolicies.js'

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
