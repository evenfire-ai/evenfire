import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
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
import { STREAM_LIMITS } from '../src/requestLimits.js'

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
  'upstreamIdleTimeoutMs',
  'maxRetriesPerAttempt',
] as const

// Contract `LIMITS` keys that the fixture also publishes. Each must carry the
// same value on both sides.
const SHARED_LIMIT_KEYS = [
  'maxDeadlineMs',
  'maxMessages',
  'maxOutputTokens',
  'maxRequestBodyBytes',
  'maxToolCalls',
] as const

// Runtime bounds the published contract deliberately does not describe. Every
// key of `LIMITS` must be in exactly one of these two lists, so adding a key to
// `LIMITS` fails this suite until someone decides which. Publishing it takes
// three edits: the fixture's `limits`, FIXTURE_LIMIT_KEYS and
// SHARED_LIMIT_KEYS. Keeping it runtime-only takes one: add it here.
const RUNTIME_ONLY_LIMIT_KEYS = ['maxIdLength', 'maxNestingDepth'] as const

type Fixture = {
  protocolVersion: string
  origins: Record<string, string>
  supportedOperations: string[]
  oauthScopes: string[]
  limits: Record<string, unknown>
  identityHeaders: Record<string, string | boolean>
  forbiddenOrigins: string[]
  errorTaxonomy: unknown
}

function readFixture(): Fixture {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture
}

const srcDir = join(here, '../src')

// Every construction of a transport error in src, with its first code argument.
// UpstreamTimeoutError takes its metric kind first and its wire code second.
const TRANSPORT_ERROR_SITE =
  /new (?:GrokTransportError|UpstreamTimeoutError)\(\s*(?:'(?:idle|total)',\s*)?([^,)\s]+)/g

function emittedTransportCodes(): { codes: Set<string>; sites: number; constructions: number } {
  const codes = new Set<string>()
  let sites = 0
  let constructions = 0
  for (const name of readdirSync(srcDir).filter(file => file.endsWith('.ts'))) {
    const source = readFileSync(join(srcDir, name), 'utf8')
    constructions +=
      source.split('new GrokTransportError(').length - 1 +
      source.split('new UpstreamTimeoutError(').length - 1
    for (const match of source.matchAll(TRANSPORT_ERROR_SITE)) {
      const literal = /^'([a-z][a-z0-9_]+)'$/.exec(match[1]!)
      // A computed code cannot be checked against the taxonomy, so it fails here.
      expect(literal, `${name}: transport error code must be a string literal, got ${match[1]}`)
        .not.toBeNull()
      codes.add(literal![1]!)
      sites += 1
    }
  }
  return { codes, sites, constructions }
}

describe('grok-subscription contract freeze', () => {
  it('imports the origin-policy constants the proxy actually enforces', () => {
    expect(GROK_COMPLETIONS_ORIGIN).toBe(COMPLETIONS_ORIGIN)
    expect(GROK_CATALOG_ORIGIN).toBe(CATALOG_ORIGIN)
    expect(GROK_TRANSPORT_PROTOCOL).toBe(TRANSPORT_PROTOCOL_VERSION)

    const fixture = readFixture()

    expect(fixture.protocolVersion).toBe(GROK_TRANSPORT_PROTOCOL)
    expect(fixture.origins.completions).toBe(GROK_COMPLETIONS_ORIGIN)
    expect(fixture.origins.catalog).toBe(GROK_CATALOG_ORIGIN)
    expect(fixture.origins.oauthDevice).toBe('https://auth.x.ai/oauth2/device/code')
    expect(fixture.origins.oauthToken).toBe('https://auth.x.ai/oauth2/token')
    expect(fixture.origins.oauthRevoke).toBe('https://auth.x.ai/oauth2/revoke')
    expect(fixture.supportedOperations).not.toContain('oauth_browser')
    expect(fixture.supportedOperations).toContain('oauth_device')
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

  it('publishes an exact set of finite positive integer limits', () => {
    const { limits } = readFixture()
    // An unknown key is a typo or an unreviewed addition, not an extension.
    expect(Object.keys(limits).sort()).toEqual([...FIXTURE_LIMIT_KEYS].sort())
    for (const name of FIXTURE_LIMIT_KEYS) {
      const value = limits[name]
      expect(
        Number.isSafeInteger(value) && (value as number) > 0,
        `limits.${name} must be a finite positive integer, got ${JSON.stringify(value)}`
      ).toBe(true)
    }
    expect(limits.maxToolCalls).toBe(256)
    expect(limits.maxMessages).toBe(1024)
    expect(limits.maxRetriesPerAttempt).toBe(1)
  })

  it('pins the contract LIMITS to the limits the fixture publishes', () => {
    const { limits } = readFixture()
    const runtimeLimits: Record<string, number> = { ...LIMITS }
    const shared = Object.keys(runtimeLimits).filter(name => name in limits)
    expect(
      [...shared].sort(),
      'the LIMITS keys the fixture publishes changed; update SHARED_LIMIT_KEYS and FIXTURE_LIMIT_KEYS together'
    ).toEqual([...SHARED_LIMIT_KEYS])
    for (const name of shared) {
      expect({ [name]: limits[name] }).toEqual({ [name]: runtimeLimits[name] })
    }
    // `shared` only sees keys the fixture already has, so a bound added to
    // `LIMITS` alone slips past it. Close that side: every `LIMITS` key is
    // either shared or declared runtime-only.
    for (const name of RUNTIME_ONLY_LIMIT_KEYS) {
      expect(
        runtimeLimits,
        `${name} is listed as runtime-only but LIMITS no longer has it; remove it from RUNTIME_ONLY_LIMIT_KEYS`
      ).toHaveProperty(name)
      expect(
        limits,
        `${name} is published in the fixture; remove it from RUNTIME_ONLY_LIMIT_KEYS`
      ).not.toHaveProperty(name)
    }
    expect(
      Object.keys(runtimeLimits).sort(),
      'every LIMITS key must be published in the fixture or listed in RUNTIME_ONLY_LIMIT_KEYS'
    ).toEqual([...shared, ...RUNTIME_ONLY_LIMIT_KEYS].sort())
  })

  it('pins the proxy STREAM_LIMITS to the limits the fixture publishes', () => {
    // StreamGate and the upstream deadlines enforce these published bounds
    // from the proxy's own constant, not from the contract package.
    const { limits } = readFixture()
    const streamLimits: Record<string, number> = { ...STREAM_LIMITS }
    expect(Object.keys(streamLimits).sort()).toEqual([
      'maxConcurrentStreams',
      'maxQueuedRequests',
      'maxStreamDurationMs',
      'upstreamIdleTimeoutMs',
    ])
    for (const name of Object.keys(streamLimits)) {
      expect({ [name]: limits[name] }).toEqual({ [name]: streamLimits[name] })
    }
  })

  it('publishes a well-formed errorTaxonomy with the codes the transport contract names', () => {
    const { errorTaxonomy } = readFixture()
    expect(Array.isArray(errorTaxonomy) && errorTaxonomy.length > 0).toBe(true)
    const codes = errorTaxonomy as unknown[]
    for (const code of codes) {
      expect(typeof code).toBe('string')
      expect(String(code)).toMatch(/^[a-z][a-z0-9_]+$/)
    }
    expect(new Set(codes).size, 'errorTaxonomy must not repeat a code').toBe(codes.length)
    expect(codes).toEqual(
      expect.arrayContaining([
        'tool_call_limit_exceeded',
        'tool_call_arguments_exceeded',
        'client_upgrade_required',
        'sse_buffer_exceeded',
        'stream_duration_exceeded',
      ])
    )
  })

  it('publishes every transport error code the proxy emits in the fixture errorTaxonomy', () => {
    const errorTaxonomy = readFixture().errorTaxonomy as string[]
    const { codes, sites, constructions } = emittedTransportCodes()
    // Liveness witness: the pattern read the code of every construction a
    // plain substring count finds, including both upstream timeout codes.
    expect(constructions).toBeGreaterThanOrEqual(15)
    expect(sites).toBe(constructions)
    expect([...codes]).toEqual(
      expect.arrayContaining(['provider_unavailable', 'stream_duration_exceeded'])
    )
    const unpublished = [...codes].filter(code => !errorTaxonomy.includes(code)).sort()
    expect(unpublished, 'emitted transport codes missing from errorTaxonomy').toEqual([])
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
