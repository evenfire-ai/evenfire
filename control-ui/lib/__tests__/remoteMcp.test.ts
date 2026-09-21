import { describe, expect, it } from 'vitest'
import {
  DCR_CONFIDENTIAL_DETECTED,
  DCR_PUBLIC_DETECTED,
  NOTION_DETECTED,
} from '../../test/fixtures/remoteMcpDiscovery'
import {
  buildRemoteInstallRequest,
  describeDiscoveryError,
  displayClientMode,
  getRemoteServerNameError,
  installModeForRegistration,
  mapRemoteDiscoverError,
  mapRemoteInstallError,
  requiresPreRegisteredCredentials,
  shouldWarnNoRefresh,
} from '../remoteMcp'
import type { RemoteDetected } from '../remoteMcp.types'

describe('installModeForRegistration (D-3/D-7)', () => {
  it('maps each registration mode to its install mode', () => {
    expect(installModeForRegistration('cimd')).toBe('cimd')
    expect(installModeForRegistration('dcr')).toBe('dcr')
    // D-7: the only supported "manual" degradation is a pre-registered client.
    expect(installModeForRegistration('manual')).toBe('pre-registered')
    expect(installModeForRegistration('pre-registered')).toBe('pre-registered')
  })
})

describe('requiresPreRegisteredCredentials (D-5)', () => {
  it('asks for credentials only in the pre-registered mode', () => {
    expect(requiresPreRegisteredCredentials('pre-registered')).toBe(true)
    expect(requiresPreRegisteredCredentials('cimd')).toBe(false)
    expect(requiresPreRegisteredCredentials('dcr')).toBe(false)
  })

  it('lines up with the mode mapping for every registration mode', () => {
    // manual → pre-registered → needs credentials; cimd/dcr → no credentials.
    expect(requiresPreRegisteredCredentials(installModeForRegistration('manual'))).toBe(true)
    expect(requiresPreRegisteredCredentials(installModeForRegistration('cimd'))).toBe(false)
    expect(requiresPreRegisteredCredentials(installModeForRegistration('dcr'))).toBe(false)
  })
})

describe('shouldWarnNoRefresh (D-8)', () => {
  it('warns iff supportsRefresh is false', () => {
    expect(shouldWarnNoRefresh({ quirks: { bearerInBody: false, supportsRefresh: false } })).toBe(
      true
    )
    expect(shouldWarnNoRefresh({ quirks: { bearerInBody: false, supportsRefresh: true } })).toBe(
      false
    )
  })

  it('does not warn for a refresh-capable real pilot', () => {
    expect(shouldWarnNoRefresh(NOTION_DETECTED)).toBe(false)
  })
})

describe('displayClientMode', () => {
  it('derives the confirm-step client mode from the resolved install mode', () => {
    expect(displayClientMode(NOTION_DETECTED)).toBe('public') // cimd
    expect(displayClientMode(DCR_PUBLIC_DETECTED)).toBe('public')
    expect(displayClientMode(DCR_CONFIDENTIAL_DETECTED)).toBe('confidential')
    const manual: RemoteDetected = { ...NOTION_DETECTED, registrationMode: 'manual' }
    expect(displayClientMode(manual)).toBe('confidential') // pre-registered
  })
})

describe('getRemoteServerNameError', () => {
  it('requires a name', () => {
    expect(getRemoteServerNameError('')).toMatch(/required/i)
    expect(getRemoteServerNameError('   ')).toMatch(/required/i)
  })

  it('accepts a valid RFC1123 label', () => {
    expect(getRemoteServerNameError('notion-remote')).toBe('')
    expect(getRemoteServerNameError('mcp0')).toBe('')
  })

  it('rejects invalid names', () => {
    expect(getRemoteServerNameError('Notion_Remote')).not.toBe('')
    expect(getRemoteServerNameError('-leading')).not.toBe('')
    expect(getRemoteServerNameError('trailing-')).not.toBe('')
    expect(getRemoteServerNameError('a'.repeat(64))).not.toBe('')
  })
})

describe('buildRemoteInstallRequest', () => {
  it('omits credentials for non-pre-registered modes and trims fields', () => {
    const body = buildRemoteInstallRequest({
      serverName: '  notion-remote ',
      contextRef: 'research',
      baseUrl: '  https://mcp.notion.com/mcp  ',
      mode: 'cimd',
      grantScope: 'user',
      clientId: 'should-not-be-sent',
      clientSecret: 'should-not-be-sent',
    })
    expect(body).toEqual({
      serverName: 'notion-remote',
      contextRef: 'research',
      baseUrl: 'https://mcp.notion.com/mcp',
      mode: 'cimd',
      grantScope: 'user',
    })
    expect(body.clientId).toBeUndefined()
    expect(body.clientSecret).toBeUndefined()
  })

  it('includes credentials for the pre-registered mode', () => {
    const body = buildRemoteInstallRequest({
      serverName: 'atlassian',
      contextRef: 'research',
      baseUrl: 'https://mcp.atlassian.com/mcp',
      mode: 'pre-registered',
      grantScope: 'context',
      clientId: '  client-abc  ',
      clientSecret: 'super-secret',
    })
    expect(body.mode).toBe('pre-registered')
    expect(body.clientId).toBe('client-abc')
    // The secret is passed through untrimmed (a secret may legitimately have edges).
    expect(body.clientSecret).toBe('super-secret')
    expect(body.grantScope).toBe('context')
  })
})

describe('describeDiscoveryError', () => {
  it('has distinct copy per kind and a fallback', () => {
    const kinds = [
      'fetch_failed',
      'content_encoding_rejected',
      'kernel_rejected',
      'invalid_metadata',
      'no_s256',
      'no_authorization_server',
      'redirect_blocked',
      'prm_resource_mismatch',
      'issuer_mismatch',
    ] as const
    const texts = kinds.map(describeDiscoveryError)
    expect(new Set(texts).size).toBe(kinds.length)
    for (const t of texts) expect(t.length).toBeGreaterThan(0)
    expect(describeDiscoveryError(undefined)).toMatch(/discovery failed/i)
    expect(describeDiscoveryError('some-future-kind')).toMatch(/discovery failed/i)
  })
})

describe('mapRemoteDiscoverError', () => {
  it('maps a discovery_failed detail kind', () => {
    const err = Object.assign(new Error('502 ...'), {
      status: 502,
      code: 'discovery_failed',
      body: { error: 'discovery_failed', detail: { kind: 'fetch_failed' } },
    })
    expect(mapRemoteDiscoverError(err)).toBe(describeDiscoveryError('fetch_failed'))
  })

  it('surfaces the kernel §4 message verbatim', () => {
    const err = Object.assign(
      new Error('400 Bad Request - baseUrl resolves to a private address'),
      {
        status: 400,
        code: 'baseUrl resolves to a private address',
        message: '400 Bad Request - baseUrl resolves to a private address',
      }
    )
    expect(mapRemoteDiscoverError(err)).toContain('private address')
  })
})

describe('mapRemoteInstallError', () => {
  it('uses the server message for mode_unsupported', () => {
    const err = Object.assign(new Error('400'), {
      status: 400,
      code: 'mode_unsupported',
      body: {
        error: 'mode_unsupported',
        message:
          'this authorization server requires dynamic client registration; install with mode "dcr"',
      },
    })
    expect(mapRemoteInstallError(err)).toContain('dynamic client registration')
  })

  it('maps auth_method_unsupported', () => {
    const err = Object.assign(new Error('400'), { code: 'auth_method_unsupported', body: {} })
    expect(mapRemoteInstallError(err)).toMatch(/authentication method/i)
  })

  it('maps dcr_registration_failed with its detail kind', () => {
    const err = Object.assign(new Error('400'), {
      code: 'dcr_registration_failed',
      body: { error: 'dcr_registration_failed', detail: { kind: 'invalid_response' } },
    })
    expect(mapRemoteInstallError(err)).toContain('invalid_response')
  })

  it('maps callback_base_url_unconfigured to plain copy', () => {
    const err = Object.assign(new Error('503'), {
      code: 'callback_base_url_unconfigured',
      body: {},
    })
    expect(mapRemoteInstallError(err)).toMatch(/callback url is not configured/i)
  })

  it('maps a re-run discovery_failed at install', () => {
    const err = Object.assign(new Error('400'), {
      code: 'discovery_failed',
      body: { error: 'discovery_failed', detail: { kind: 'no_s256' } },
    })
    expect(mapRemoteInstallError(err)).toBe(describeDiscoveryError('no_s256'))
  })

  it('passes through a context-not-found / allowlist error message', () => {
    const err = Object.assign(new Error('404 Not Found - context "research" not found'), {
      status: 404,
      code: 'context "research" not found',
      message: '404 Not Found - context "research" not found',
    })
    expect(mapRemoteInstallError(err)).toContain('context "research" not found')
  })
})
