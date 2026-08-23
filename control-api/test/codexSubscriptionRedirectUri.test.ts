import { describe, expect, it } from 'vitest'
import {
  PUBLIC_CODEX_CLI_CLIENT_ID,
  buildCodexBrowserRedirectUri,
  buildCodexBrowserReturnLocation,
  isPublicCodexCliClient,
  resolveCodexCallbackControlUiBaseUrl,
  resolveCodexControlUiBaseUrl,
} from '../src/services/codexSubscriptionRedirectUri.js'

describe('codex subscription redirect URI', () => {
  it('builds the control-ui proxied callback from the cluster public origin', () => {
    expect(buildCodexBrowserRedirectUri('https://control.example.com')).toBe(
      'https://control.example.com/control-api/api/v1/auth/codex-subscription/callback'
    )
    expect(buildCodexBrowserRedirectUri('http://127.0.0.1:36148/')).toBe(
      'http://127.0.0.1:36148/control-api/api/v1/auth/codex-subscription/callback'
    )
  })

  it('never emits the Codex CLI loopback redirect', () => {
    const redirect = buildCodexBrowserRedirectUri('http://127.0.0.1:36148')
    expect(redirect).not.toContain(':1455')
    expect(redirect).not.toMatch(/\/auth\/callback$/)
  })

  it('rejects invalid control-ui base URLs', () => {
    expect(() => buildCodexBrowserRedirectUri('')).toThrow()
    expect(() => buildCodexBrowserRedirectUri('not-a-url')).toThrow()
    expect(() => buildCodexBrowserRedirectUri('https://control.example.com/extra')).toThrow()
  })

  it('accepts loopback Origin overrides only for local profiles', () => {
    expect(resolveCodexControlUiBaseUrl('http://127.0.0.1:3000', 'http://127.0.0.1:36148')).toBe(
      'http://127.0.0.1:36148'
    )
    expect(
      resolveCodexControlUiBaseUrl('https://control.example.com', 'https://evil.example.com')
    ).toBe('https://control.example.com')
  })

  it('prefers forwarded host on OAuth callback requests', () => {
    expect(
      resolveCodexCallbackControlUiBaseUrl({
        configuredBaseUrl: 'http://127.0.0.1:3000',
        forwardedHost: '127.0.0.1:36148',
        forwardedProto: 'http',
      })
    ).toBe('http://127.0.0.1:36148')
  })

  it('ignores a non-loopback forwarded host that does not match the configured origin', () => {
    expect(
      resolveCodexCallbackControlUiBaseUrl({
        configuredBaseUrl: 'https://control.example.com',
        forwardedHost: 'evil.example.com',
        forwardedProto: 'https',
      })
    ).toBe('https://control.example.com')
  })

  it('identifies the public Codex CLI client id', () => {
    expect(isPublicCodexCliClient(PUBLIC_CODEX_CLI_CLIENT_ID)).toBe(true)
    expect(isPublicCodexCliClient('app_evenfire_custom')).toBe(false)
  })

  it('builds a relative browser return location', () => {
    expect(buildCodexBrowserReturnLocation('connected')).toBe(
      '/llm-models/providers/codex-subscription?codex_oauth=connected'
    )
  })
})
