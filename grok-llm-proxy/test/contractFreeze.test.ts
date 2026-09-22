import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CATALOG_ORIGIN,
  COMPLETIONS_ORIGIN,
  LIMITS,
  TRANSPORT_PROTOCOL_VERSION,
} from '@clerum/grok-provider-attempt-contract'
import {
  GROK_UPSTREAM_CLIENT_IDENTIFIER,
  GROK_UPSTREAM_USER_AGENT,
} from '../src/grokUpstreamHeaders.js'
import {
  GROK_CATALOG_ORIGIN,
  GROK_COMPLETIONS_ORIGIN,
  GROK_TRANSPORT_PROTOCOL,
} from '../src/originPolicy.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(
  here,
  '../../tests/e2e/fixtures/grok-subscription/sanitized-upstream-contract.json'
)

// The limits the frozen fixture publishes, exactly.
const FIXTURE_LIMIT_KEYS = [
  'maxRequestBodyBytes',
  'maxMessages',
  'maxToolCalls',
  'maxOutputTokens',
  'maxStreamDurationMs',
  'maxDeadlineMs',
  'maxConcurrentStreams',
  'maxQueuedRequests',
  'maxRetriesPerAttempt',
] as const

// Runtime bounds the published contract deliberately does not describe. Every
// key of `LIMITS` must be either published (in the fixture with the same
// value) or listed here, so adding a key to `LIMITS` fails this suite until
// someone decides which: publish it in the fixture, or name it here.
const RUNTIME_ONLY_LIMIT_KEYS = ['maxIdLength', 'maxNestingDepth'] as const

describe('grok-subscription contract freeze', () => {
  it('imports the origin-policy constants the proxy actually enforces', () => {
    expect(GROK_COMPLETIONS_ORIGIN).toBe(COMPLETIONS_ORIGIN)
    expect(GROK_CATALOG_ORIGIN).toBe(CATALOG_ORIGIN)
    expect(GROK_TRANSPORT_PROTOCOL).toBe(TRANSPORT_PROTOCOL_VERSION)

    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      protocolVersion: string
      origins: Record<string, string>
      supportedOperations: string[]
      oauthScopes: string[]
      limits: Record<string, number>
      identityHeaders: Record<string, string | boolean>
      forbiddenOrigins: string[]
    }

    expect(fixture.protocolVersion).toBe(GROK_TRANSPORT_PROTOCOL)
    expect(fixture.origins.completions).toBe(GROK_COMPLETIONS_ORIGIN)
    expect(fixture.origins.catalog).toBe(GROK_CATALOG_ORIGIN)
    expect(fixture.origins.oauthDevice).toBe('https://auth.x.ai/oauth2/device/code')
    expect(fixture.origins.oauthToken).toBe('https://auth.x.ai/oauth2/token')
    expect(fixture.origins.oauthRevoke).toBe('https://auth.x.ai/oauth2/revoke')
    expect(fixture.supportedOperations).not.toContain('oauth_browser')
    expect(fixture.supportedOperations).toContain('oauth_device')
    expect(fixture.limits.maxToolCalls).toBe(LIMITS.maxToolCalls)
    expect(fixture.limits.maxToolCalls).toBe(256)
    expect(fixture.limits.maxMessages).toBe(LIMITS.maxMessages)
    expect(fixture.limits.maxMessages).toBe(1024)
    expect(fixture.limits.maxRetriesPerAttempt).toBe(1)
    // Every other bound the fixture shares with the contract, cross-checked the
    // same way. Without this, a raise in `LIMITS` that forgets the fixture is
    // caught for these two fields and silently accepted for the rest.
    const shared = Object.keys(LIMITS).filter(name => name in fixture.limits)
    expect(shared).toEqual([
      'maxRequestBodyBytes',
      'maxMessages',
      'maxToolCalls',
      'maxOutputTokens',
      'maxDeadlineMs',
    ])
    for (const name of shared) {
      expect({ [name]: fixture.limits[name] }).toEqual({
        [name]: LIMITS[name as keyof typeof LIMITS],
      })
    }
    // `shared` only sees keys the fixture already has, so a bound added to
    // `LIMITS` alone slips past it. Close that side: the fixture key set is
    // exact, and every `LIMITS` key is either shared or declared runtime-only.
    expect(Object.keys(fixture.limits).sort()).toEqual([...FIXTURE_LIMIT_KEYS].sort())
    for (const name of RUNTIME_ONLY_LIMIT_KEYS) {
      expect(
        LIMITS,
        `${name} is listed as runtime-only but LIMITS no longer has it; remove it from RUNTIME_ONLY_LIMIT_KEYS`
      ).toHaveProperty(name)
      expect(
        fixture.limits,
        `${name} is published in the fixture; remove it from RUNTIME_ONLY_LIMIT_KEYS`
      ).not.toHaveProperty(name)
    }
    expect(
      Object.keys(LIMITS).sort(),
      'every LIMITS key must be published in the fixture or listed in RUNTIME_ONLY_LIMIT_KEYS'
    ).toEqual([...shared, ...RUNTIME_ONLY_LIMIT_KEYS].sort())
    // Live xAI gates subscription inference on a client version (426 probe,
    // 2026-09-18), so we send one — but the identity stays Evenfire's and never
    // claims to be the Grok CLI itself.
    expect(String(fixture.identityHeaders['user-agent'])).toContain(GROK_UPSTREAM_USER_AGENT)
    expect(fixture.identityHeaders['x-grok-client-identifier']).toBe(
      GROK_UPSTREAM_CLIENT_IDENTIFIER
    )
    expect(fixture.identityHeaders['x-xai-token-auth']).toBe('xai-grok-cli')
    expect(fixture.identityHeaders.cliImpersonation).toBe(false)
    expect(JSON.stringify(fixture.identityHeaders)).not.toContain('grok-shell')
    expect(JSON.stringify(fixture.identityHeaders)).not.toContain('xai-grok-workspace')
    expect(fixture.oauthScopes).toEqual(
      expect.arrayContaining(['openid', 'offline_access', 'grok-cli:access', 'api:access'])
    )
    expect(fixture.forbiddenOrigins).toEqual(expect.arrayContaining(['https://api.x.ai']))
    expect(GROK_COMPLETIONS_ORIGIN).not.toContain('api.x.ai')
    expect(GROK_CATALOG_ORIGIN).not.toContain('api.x.ai')
  })

  it('mirrors the exact OAuth origins control-api dials, including revoke', () => {
    // control-api owns the OAuth client; the proxy never dials auth.x.ai. Cross-
    // check the frozen fixture against control-api's exported constants by
    // source so a drift in either side fails here without importing control-api.
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      origins: Record<string, string>
    }
    const oauthSource = readFileSync(
      join(here, '../../control-api/src/services/grokSubscriptionOAuth.ts'),
      'utf8'
    )
    const constant = (name: string): string | undefined =>
      new RegExp(`export const ${name} = '([^']+)'`).exec(oauthSource)?.[1]
    expect(constant('GROK_OAUTH_DEVICE_URL')).toBe(fixture.origins.oauthDevice)
    expect(constant('GROK_OAUTH_TOKEN_URL')).toBe(fixture.origins.oauthToken)
    expect(constant('GROK_OAUTH_REVOKE_URL')).toBe(fixture.origins.oauthRevoke)
    expect(fixture.origins.oauthRevoke).toBe('https://auth.x.ai/oauth2/revoke')
  })
})
