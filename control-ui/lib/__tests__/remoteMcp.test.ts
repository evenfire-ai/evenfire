import { describe, expect, it } from 'vitest'
import {
  NOTION_TRANSPORT_ALIVE,
  TRANSPORT_INCONCLUSIVE_TIMEOUT,
  VERCEL_TRANSPORT_DEAD,
} from '../../test/fixtures/remoteMcpDiscovery'
import {
  ATLASSIAN_DISCOVER,
  ATLASSIAN_DISCOVER_UNCONFIGURED,
  CALLBACK_UNCONFIGURED_FAILURE,
  CIMD_WITHOUT_ISS_BINDING_FAILURE,
  CLIENT_ID_IN_USE_FAILURE,
  DCR_CONFIDENTIAL_DETECTED,
  DCR_REDIRECT_MISMATCH_FAILURE,
  DROPBOX_DISCOVER_FAILURE,
  ISSUER_PUBLIC_SUFFIX_DISCOVER_FAILURE,
  LINEAR_DETECTED,
  LINEAR_DISCOVER,
  LINEAR_DISCOVER_UNCONFIGURED,
  NOTION_DETECTED,
  NOTION_DISCOVER,
  OLDER_CONTROL_API_DCR_DISCOVER,
  OLDER_CONTROL_API_LINEAR_DISCOVER,
  PRE_REGISTERED_PER_SERVER_DETECTED,
  PRE_REGISTERED_PER_SERVER_DISCOVER,
  apiErrorFrom,
} from '../../test/fixtures/remoteMcpWire'
import {
  buildRemoteInstallRequest,
  describeDiscoveryError,
  describeTransportProbe,
  displayClientMode,
  getRemoteBaseUrlError,
  getRemoteServerNameError,
  installModeForRegistration,
  mapRemoteDiscoverError,
  mapRemoteInstallError,
  remoteCallbackBlocker,
  remoteCallbackVariant,
  remotePreRegisteredRedirectUri,
  requiresPreRegisteredCredentials,
  shouldWarnNoRefresh,
  transportBlocksContinue,
} from '../remoteMcp'
import type { RemoteTransportProbe } from '../remoteMcp.types'

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
    expect(displayClientMode(LINEAR_DETECTED)).toBe('public') // cimd
    expect(displayClientMode(NOTION_DETECTED)).toBe('public') // dcr, `none` offered
    expect(displayClientMode(DCR_CONFIDENTIAL_DETECTED)).toBe('confidential')
    expect(displayClientMode(PRE_REGISTERED_PER_SERVER_DETECTED)).toBe('confidential')
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

describe('remoteCallbackVariant', () => {
  it('reads the backend callback preview', () => {
    expect(remoteCallbackVariant(LINEAR_DISCOVER)).toBe('shared')
    expect(remoteCallbackVariant(NOTION_DISCOVER)).toBe('per-server')
    expect(remoteCallbackVariant(PRE_REGISTERED_PER_SERVER_DISCOVER)).toBe('per-server')
  })

  it('on a control-api without the preview, falls back to the RFC 9207 rule', () => {
    expect(remoteCallbackVariant(OLDER_CONTROL_API_LINEAR_DISCOVER)).toBe('shared')
    expect(remoteCallbackVariant(OLDER_CONTROL_API_DCR_DISCOVER)).toBe('per-server')
  })
})

describe('remoteCallbackBlocker', () => {
  it('does not block a configured shared or per-server install', () => {
    expect(remoteCallbackBlocker(LINEAR_DISCOVER)).toBe('')
    expect(remoteCallbackBlocker(ATLASSIAN_DISCOVER)).toBe('')
    expect(remoteCallbackBlocker(PRE_REGISTERED_PER_SERVER_DISCOVER)).toBe('')
  })

  it('blocks a per-server install when the callback base URL is not configured', () => {
    expect(remoteCallbackBlocker(ATLASSIAN_DISCOVER_UNCONFIGURED)).toMatch(
      /callback URL is not configured/i
    )
  })

  it('does not block a shared install without a configured base URL', () => {
    // control-api decides per mode there (a shared CIMD/DCR install still answers 503).
    expect(LINEAR_DISCOVER_UNCONFIGURED.callback).toEqual({ configured: false, variant: 'shared' })
    expect(remoteCallbackBlocker(LINEAR_DISCOVER_UNCONFIGURED)).toBe('')
  })

  it('on an older control-api, blocks every install against an AS without RFC 9207', () => {
    expect(OLDER_CONTROL_API_DCR_DISCOVER.detected.registrationMode).toBe('dcr')
    expect(remoteCallbackBlocker(OLDER_CONTROL_API_DCR_DISCOVER)).toMatch(/update control-api/i)
    expect(remoteCallbackBlocker(OLDER_CONTROL_API_LINEAR_DISCOVER)).toBe('')
  })
})

describe('remotePreRegisteredRedirectUri', () => {
  const perServer = PRE_REGISTERED_PER_SERVER_DISCOVER.callback

  it('fills the server name into the per-server template', () => {
    expect(remotePreRegisteredRedirectUri(perServer, 'hubspot')).toBe(
      perServer?.redirectUriTemplate?.replace('{serverName}', 'hubspot')
    )
    expect(remotePreRegisteredRedirectUri(perServer, 'hubspot')).toMatch(
      /\/api\/v1\/oauth-callback\/remote\/hubspot$/
    )
  })

  it('shows nothing until the name is valid', () => {
    expect(remotePreRegisteredRedirectUri(perServer, '')).toBeNull()
    expect(remotePreRegisteredRedirectUri(perServer, 'Bad_Name')).toBeNull()
    expect(remotePreRegisteredRedirectUri(perServer, '-x')).toBeNull()
  })

  it('returns the shared URI as-is, whatever the name', () => {
    expect(remotePreRegisteredRedirectUri(LINEAR_DISCOVER.callback, '')).toBe(
      LINEAR_DISCOVER.callback?.redirectUriTemplate
    )
  })

  it('never shows a DCR template (control-api registers it) nor an unconfigured one', () => {
    expect(remotePreRegisteredRedirectUri(ATLASSIAN_DISCOVER.callback, 'atlassian')).toBeNull()
    expect(
      remotePreRegisteredRedirectUri(ATLASSIAN_DISCOVER_UNCONFIGURED.callback, 'atlassian')
    ).toBeNull()
    expect(remotePreRegisteredRedirectUri(undefined, 'atlassian')).toBeNull()
  })
})

describe('getRemoteBaseUrlError', () => {
  it('requires a URL', () => {
    expect(getRemoteBaseUrlError('')).toMatch(/required/i)
    expect(getRemoteBaseUrlError('   ')).toMatch(/required/i)
  })

  it('accepts an absolute https URL with a fully-qualified host', () => {
    expect(getRemoteBaseUrlError('https://mcp.notion.com/mcp')).toBe('')
    expect(getRemoteBaseUrlError('  https://mcp.example.com  ')).toBe('')
  })

  it('rejects a non-https scheme', () => {
    expect(getRemoteBaseUrlError('http://mcp.notion.com/mcp')).toMatch(/https/i)
    expect(getRemoteBaseUrlError('ftp://mcp.notion.com')).not.toBe('')
  })

  it('rejects a non-absolute or malformed URL', () => {
    expect(getRemoteBaseUrlError('mcp.notion.com/mcp')).not.toBe('')
    expect(getRemoteBaseUrlError('not a url')).not.toBe('')
  })

  it('rejects a URL with spaces', () => {
    expect(getRemoteBaseUrlError('https://mcp.notion.com/ mcp')).toMatch(/space/i)
  })

  it('rejects a non-fully-qualified hostname', () => {
    expect(getRemoteBaseUrlError('https://localhost/mcp')).toMatch(/fully-qualified/i)
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
      'as_endpoints_cross_site',
    ] as const
    const texts = kinds.map(describeDiscoveryError)
    expect(new Set(texts).size).toBe(kinds.length)
    for (const t of texts) expect(t.length).toBeGreaterThan(0)
    expect(describeDiscoveryError(undefined)).toMatch(/discovery failed/i)
    expect(describeDiscoveryError('some-future-kind')).toMatch(/discovery failed/i)
  })
})

describe('mapRemoteDiscoverError', () => {
  it('maps the Dropbox cross-site failure naming the offending endpoint', () => {
    const copy = mapRemoteDiscoverError(apiErrorFrom(DROPBOX_DISCOVER_FAILURE))
    expect(copy).toMatch(/token endpoint is not on the issuer's domain/i)
    expect(copy).toMatch(/RFC 9207/)
  })

  it('maps an issuer without a registrable domain to its own copy', () => {
    const copy = mapRemoteDiscoverError(apiErrorFrom(ISSUER_PUBLIC_SUFFIX_DISCOVER_FAILURE))
    expect(copy).toMatch(/issuer has no registrable domain/i)
    expect(copy).not.toMatch(/endpoint is not on/i)
    expect(copy).not.toBe(mapRemoteDiscoverError(apiErrorFrom(DROPBOX_DISCOVER_FAILURE)))
  })

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

  it('maps callback_base_url_unconfigured by the previewed callback variant', () => {
    const err = apiErrorFrom(CALLBACK_UNCONFIGURED_FAILURE)
    const perServer = mapRemoteInstallError(err, { callbackVariant: 'per-server' })
    expect(perServer).toMatch(/callback url is not configured/i)
    expect(perServer).toMatch(/redirect URI of its own/i)
    // Shared CIMD/DCR without an origin answer the same 503; so does an unknown variant.
    for (const copy of [
      mapRemoteInstallError(err, { callbackVariant: 'shared' }),
      mapRemoteInstallError(err),
    ]) {
      expect(copy).toMatch(/callback url is not configured/i)
      expect(copy).toMatch(/CONTROL_API_OAUTH_CALLBACK_BASE_URL/)
      expect(copy).not.toMatch(/redirect URI of its own/i)
    }
  })

  it('uses the server message when CIMD is refused for lack of RFC 9207', () => {
    expect(mapRemoteInstallError(apiErrorFrom(CIMD_WITHOUT_ISS_BINDING_FAILURE))).toBe(
      'this authorization server supports CIMD but not RFC 9207; install with mode "dcr"'
    )
  })

  it('maps a per-server client_id conflict to "register a separate client"', () => {
    const copy = mapRemoteInstallError(apiErrorFrom(CLIENT_ID_IN_USE_FAILURE))
    expect(copy).toMatch(/another remote server/i)
    expect(copy).toMatch(/separate OAuth client/i)
  })

  it('maps each oauth_client_id_in_use conflict to its own copy', () => {
    const copies = ['remote_server', 'dynamic_client', 'cimd_client', undefined].map(conflict =>
      mapRemoteInstallError(
        Object.assign(new Error('409'), {
          code: 'oauth_client_id_in_use',
          body: { error: 'oauth_client_id_in_use', conflict },
        })
      )
    )
    expect(new Set(copies).size).toBe(copies.length)
  })

  it('maps a refused DCR redirect URI without leaking the raw kind', () => {
    const copy = mapRemoteInstallError(apiErrorFrom(DCR_REDIRECT_MISMATCH_FAILURE))
    expect(copy).toMatch(/different redirect URI/i)
    expect(copy).toMatch(/nothing was installed/i)
    expect(copy).not.toContain('redirect_uris_mismatch')
  })

  it('gives each refused-DCR kind its own copy', () => {
    const kinds = ['redirect_uris_mismatch', 'redirect_uris_missing', 'client_id_is_cimd_identity']
    const copies = kinds.map(kind =>
      mapRemoteInstallError(
        Object.assign(new Error('400'), {
          code: 'dcr_registration_failed',
          body: { error: 'dcr_registration_failed', detail: { kind } },
        })
      )
    )
    expect(new Set(copies).size).toBe(kinds.length)
    for (const [i, copy] of copies.entries()) expect(copy).not.toContain(kinds[i])
  })

  it('maps issuer_binding_required to the server message, else neutral copy', () => {
    // No golden: the router now answers a CIMD request against an AS without RFC 9207
    // with mode_unsupported first, so this 422 is only a defensive branch there.
    const withMessage = Object.assign(new Error('422'), {
      code: 'issuer_binding_required',
      body: { error: 'issuer_binding_required', message: 'a CIMD install requires it' },
    })
    expect(mapRemoteInstallError(withMessage)).toBe('a CIMD install requires it')
    const bare = Object.assign(new Error('422'), {
      code: 'issuer_binding_required',
      body: { error: 'issuer_binding_required' },
    })
    expect(mapRemoteInstallError(bare)).toMatch(/does not advertise RFC 9207/)
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

  it('maps transport_unreachable with the suggested canonical URL', () => {
    const err = Object.assign(new Error('400'), {
      status: 400,
      code: 'transport_unreachable',
      body: {
        error: 'transport_unreachable',
        detail: {
          probedUrl: 'https://mcp.vercel.com/mcp',
          httpStatus: 404,
          suggestedBaseUrl: 'https://mcp.vercel.com/',
        },
      },
    })
    const copy = mapRemoteInstallError(err)
    expect(copy).toContain('https://mcp.vercel.com/')
    expect(copy).toContain('404')
  })

  it('maps transport_unreachable without a suggestion', () => {
    const err = Object.assign(new Error('400'), {
      code: 'transport_unreachable',
      body: {
        error: 'transport_unreachable',
        detail: { probedUrl: 'https://mcp.example.com/mcp', httpStatus: 405 },
      },
    })
    const copy = mapRemoteInstallError(err)
    expect(copy).toMatch(/isn't reachable/i)
    expect(copy).toContain('405')
    expect(copy).not.toContain('looks like')
  })
})

describe('transportBlocksContinue', () => {
  it('blocks only on a proven dead transport', () => {
    expect(transportBlocksContinue(VERCEL_TRANSPORT_DEAD)).toBe(true)
    expect(transportBlocksContinue(NOTION_TRANSPORT_ALIVE)).toBe(false)
    expect(transportBlocksContinue(TRANSPORT_INCONCLUSIVE_TIMEOUT)).toBe(false)
    // An absent probe (older control-api) never blocks.
    expect(transportBlocksContinue(undefined)).toBe(false)
  })
})

describe('describeTransportProbe', () => {
  it('does not describe an alive transport (the summary row handles it)', () => {
    expect(describeTransportProbe(NOTION_TRANSPORT_ALIVE)).toBe('')
  })

  it('describes a dead transport with its suggested canonical URL', () => {
    const copy = describeTransportProbe(VERCEL_TRANSPORT_DEAD)
    expect(copy).toContain('404')
    expect(copy).toContain('https://mcp.vercel.com/')
    expect(copy).toMatch(/looks like/i)
  })

  it('describes a dead transport without a suggestion differently', () => {
    const dead: RemoteTransportProbe = {
      status: 'dead',
      probedUrl: 'https://mcp.example.com/mcp',
      httpStatus: 405,
    }
    const copy = describeTransportProbe(dead)
    expect(copy).toContain('405')
    expect(copy).toMatch(/double-check the url path/i)
    expect(copy).not.toMatch(/looks like/i)
  })

  it('gives a distinct, non-blocking message per inconclusive reason', () => {
    const timeout = describeTransportProbe(TRANSPORT_INCONCLUSIVE_TIMEOUT)
    expect(timeout).toMatch(/timed out/i)
    expect(timeout).toMatch(/can still install/i)

    const redirect = describeTransportProbe({
      status: 'inconclusive',
      probedUrl: 'https://mcp.example.com/mcp',
      reason: 'redirect',
      detail: 'redirected',
    })
    expect(redirect).toMatch(/redirect/i)

    const unexpected = describeTransportProbe({
      status: 'inconclusive',
      probedUrl: 'https://mcp.example.com/mcp',
      reason: 'unexpected_status',
      httpStatus: 500,
      detail: 'unexpected status 500',
    })
    expect(unexpected).toContain('500')

    // Every reason must return distinct copy, not the same fallback.
    const messages = (
      [
        'timeout',
        'transport_failed',
        'redirect',
        'unexpected_status',
        'content_encoding_rejected',
        'kernel_rejected',
      ] as const
    ).map(reason =>
      describeTransportProbe({
        status: 'inconclusive',
        probedUrl: 'https://mcp.example.com/mcp',
        reason,
        detail: reason,
      })
    )
    expect(new Set(messages).size).toBe(messages.length)
  })
})
