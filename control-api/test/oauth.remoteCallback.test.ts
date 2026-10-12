import { describe, expect, it, vi } from 'vitest'
import { buildCimdDocument } from '../src/oauth/cimd.js'
import { type DiscoveryResult, discoverRemoteOAuth } from '../src/oauth/discovery.js'
import {
  InvalidRemoteRedirectUriInputError,
  REMOTE_CALLBACK_PATH,
  type RemoteRedirectUriInput,
  buildRemoteRedirectUri,
  isValidInstallNonce,
  isValidRemoteServerNameSegment,
  remoteCallbackVariant,
} from '../src/oauth/remoteCallback.js'
import { buildRemoteOAuthSpec } from '../src/routes/admin/remoteMcp.js'
import {
  ATLASSIAN_V2_PILOT,
  PILOTS,
  type PilotFixture,
  makeDiscoveryTransport,
} from './fixtures/remoteOAuthDiscovery.js'

const ORIGIN = 'https://evenfire.example.com'
const NONCE = '3f1c2b7e-9a4d-4c1e-8b2a-6d5e4f3a2b1c'

async function discovered(pilot: PilotFixture): Promise<DiscoveryResult> {
  const outcome = await discoverRemoteOAuth(pilot.mcpUrl, {
    transport: makeDiscoveryTransport(pilot),
    resolveDns: vi.fn(async () => ['93.184.216.34']),
  })
  if (!outcome.ok) throw new Error(`discovery failed: ${outcome.error.kind}`)
  return outcome.result
}

describe('remoteCallbackVariant', () => {
  it('non-empty issForCallback → shared; absent, empty or non-string → per-server', () => {
    expect(remoteCallbackVariant({ issForCallback: 'https://mcp.sentry.dev' })).toBe('shared')
    expect(remoteCallbackVariant({})).toBe('per-server')
    expect(remoteCallbackVariant({ issForCallback: undefined })).toBe('per-server')
    expect(remoteCallbackVariant({ issForCallback: '' })).toBe('per-server')
    expect(remoteCallbackVariant({ issForCallback: true })).toBe('per-server')
    expect(remoteCallbackVariant({ issForCallback: 1 })).toBe('per-server')
  })
})

// Partial (unit-level) coverage of I15: the variant derived from the block the real
// producer builds, and stable across a JSON round-trip. The round-trip is NOT the CR the
// install writes and reads back from the apiserver — that composability
// (variant(install block) === variant(written CR)) is asserted with the install saga in
// phase 2.
describe('I15 (partial, unit) — remoteCallbackVariant on the block the install builds', () => {
  const cases: Array<{ pilot: PilotFixture; variant: 'shared' | 'per-server' }> = [
    { pilot: PILOTS.sentry, variant: 'shared' },
    { pilot: PILOTS.linear, variant: 'shared' },
    { pilot: PILOTS.notion, variant: 'per-server' },
    { pilot: ATLASSIAN_V2_PILOT, variant: 'per-server' },
  ]
  for (const { pilot, variant } of cases) {
    it(`${pilot.name}: ${variant} on the install block (JSON round-trip stable)`, async () => {
      const block = buildRemoteOAuthSpec(await discovered(pilot), {
        clientMode: 'public',
        grantScope: 'user',
        dynamicClientId: 'client-from-as',
      })
      expect(remoteCallbackVariant(block)).toBe(variant)
      // Round-trip only; not a substitute for reading the written CR.
      const fromCr = JSON.parse(JSON.stringify(block)) as Record<string, unknown>
      expect(remoteCallbackVariant(fromCr)).toBe(remoteCallbackVariant(block))
    })
  }
})

describe('buildRemoteRedirectUri — decision table', () => {
  it('shared → the stable shared path (any mode)', () => {
    expect(buildRemoteRedirectUri({ origin: ORIGIN, variant: 'shared' })).toBe(
      `${ORIGIN}/api/v1/oauth-callback/remote`
    )
    expect(REMOTE_CALLBACK_PATH).toBe('/api/v1/oauth-callback/remote')
  })

  it('per-server DCR → /remote/<serverName>/<installNonce>', () => {
    expect(
      buildRemoteRedirectUri({
        origin: ORIGIN,
        variant: 'per-server',
        mode: 'dcr',
        serverName: 'atlassian',
        installNonce: NONCE,
      })
    ).toBe(`${ORIGIN}/api/v1/oauth-callback/remote/atlassian/${NONCE}`)
  })

  it('per-server pre-registered → /remote/<serverName>', () => {
    expect(
      buildRemoteRedirectUri({
        origin: ORIGIN,
        variant: 'per-server',
        mode: 'pre-registered',
        serverName: 'slack',
      })
    ).toBe(`${ORIGIN}/api/v1/oauth-callback/remote/slack`)
  })

  it('per-server accepts a bare origin with an explicit non-default port', () => {
    expect(
      buildRemoteRedirectUri({
        origin: 'http://localhost:8080',
        variant: 'per-server',
        mode: 'pre-registered',
        serverName: 'slack',
      })
    ).toBe('http://localhost:8080/api/v1/oauth-callback/remote/slack')
  })

  it('shared keeps its historical origin handling (no origin validation)', () => {
    expect(buildRemoteRedirectUri({ origin: `${ORIGIN}/base`, variant: 'shared' })).toBe(
      `${ORIGIN}/base/api/v1/oauth-callback/remote`
    )
  })

  it('the CIMD document lists exactly the shared URI from the same builder', () => {
    expect(buildCimdDocument(ORIGIN).redirect_uris).toEqual([
      buildRemoteRedirectUri({ origin: ORIGIN, variant: 'shared' }),
    ])
  })

  const invalid: Array<{ label: string; input: unknown }> = [
    {
      label: 'per-server CIMD (no per-server URI exists)',
      input: { origin: ORIGIN, variant: 'per-server', mode: 'cimd', serverName: 'notion' },
    },
    {
      label: 'per-server DCR without a nonce',
      input: { origin: ORIGIN, variant: 'per-server', mode: 'dcr', serverName: 'notion' },
    },
    {
      label: 'per-server pre-registered WITH a nonce',
      input: {
        origin: ORIGIN,
        variant: 'per-server',
        mode: 'pre-registered',
        serverName: 'slack',
        installNonce: NONCE,
      },
    },
    {
      label: 'uppercase UUID nonce',
      input: {
        origin: ORIGIN,
        variant: 'per-server',
        mode: 'dcr',
        serverName: 'notion',
        installNonce: NONCE.toUpperCase(),
      },
    },
    {
      label: 'per-server without an origin',
      input: { origin: '', variant: 'per-server', mode: 'pre-registered', serverName: 'slack' },
    },
    ...[
      `${ORIGIN}/`,
      `${ORIGIN}/base`,
      `${ORIGIN}?q=1`,
      `${ORIGIN}#f`,
      'https://user:pw@evenfire.example.com',
      'https://Evenfire.Example.com',
      'https://evenfire.example.com:443',
      'evenfire.example.com',
      'not a url',
    ].map(origin => ({
      label: `per-server with a non-bare origin ${JSON.stringify(origin)}`,
      input: { origin, variant: 'per-server', mode: 'pre-registered', serverName: 'slack' },
    })),
    { label: 'unknown variant', input: { origin: ORIGIN, variant: 'other' } },
  ]
  for (const { label, input } of invalid) {
    it(`throws: ${label}`, () => {
      expect(() => buildRemoteRedirectUri(input as RemoteRedirectUriInput)).toThrow(
        InvalidRemoteRedirectUriInputError
      )
    })
  }

  for (const serverName of [
    '..',
    '%2F',
    'a/b',
    'a%2Fb',
    'Notion',
    'my_server',
    '-lead',
    'trail-',
    '',
    'a'.repeat(64),
  ]) {
    it(`throws on a non-RFC-1123 serverName ${JSON.stringify(serverName)}`, () => {
      expect(() =>
        buildRemoteRedirectUri({
          origin: ORIGIN,
          variant: 'per-server',
          mode: 'pre-registered',
          serverName,
        })
      ).toThrow(InvalidRemoteRedirectUriInputError)
    })
  }
})

describe('segment validators', () => {
  it('isValidRemoteServerNameSegment accepts RFC 1123 labels only', () => {
    for (const ok of ['notion', 'a', 'atlassian-v2', 'a'.repeat(63), '0abc']) {
      expect(isValidRemoteServerNameSegment(ok)).toBe(true)
    }
    for (const bad of [
      '..',
      '.',
      '%2F',
      '%2e%2e',
      '%252F',
      'a/b',
      'A',
      'a_b',
      '-a',
      'a-',
      '',
      'a'.repeat(64),
      'a\n',
      42,
      undefined,
    ]) {
      expect(isValidRemoteServerNameSegment(bad)).toBe(false)
    }
  })

  it('isValidInstallNonce accepts only canonical lowercase UUIDs', () => {
    expect(isValidInstallNonce(NONCE)).toBe(true)
    expect(isValidInstallNonce(crypto.randomUUID())).toBe(true)
    for (const bad of [
      NONCE.toUpperCase(),
      `${NONCE}\n`,
      `{${NONCE}}`,
      NONCE.replace(/-/g, ''),
      '..',
      '%2F',
      '',
      undefined,
      42,
    ]) {
      expect(isValidInstallNonce(bad)).toBe(false)
    }
  })
})
