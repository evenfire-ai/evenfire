import { describe, expect, it } from 'vitest'
import {
  type DcrRegistrationResponse,
  buildDcrRequest,
  registerDynamicClient,
  verifyDcrRedirectUris,
} from '../src/oauth/dcr.js'
import { type DiscoveryResult, discoverRemoteOAuth } from '../src/oauth/discovery.js'
import { buildRemoteRedirectUri } from '../src/oauth/remoteCallback.js'
import {
  ATLASSIAN_V2_PILOT,
  DCR_PUBLIC_REGISTRATION_RESPONSE,
  makeDcrTransport,
  makeDiscoveryTransport,
} from './fixtures/remoteOAuthDiscovery.js'

/**
 * `redirect_uris` echoed by the AS on a registration response, checked per callback
 * variant: per-server requires it and requires it exact; shared only fails when it is
 * present and different.
 *
 * The request comes from the real builders (discovery → `buildRemoteRedirectUri` →
 * `buildDcrRequest`) and the response goes through the real parser
 * (`registerDynamicClient`), so the verifier sees exactly the shapes it will see in the
 * install. The response body itself is the RFC 7591 §3.2.1 fixture the DCR suite uses
 * (a live registration would create a real client at a third-party AS), with only
 * `redirect_uris` varied.
 */

const PUBLIC_IP = async () => ['93.184.216.34']
const ORIGIN = 'https://control.example.com'
const NONCE = '0b8f6a52-5c7d-4e21-9f3a-1d2c3b4a5e6f'

async function atlassianDiscovery(): Promise<DiscoveryResult> {
  const outcome = await discoverRemoteOAuth(ATLASSIAN_V2_PILOT.mcpUrl, {
    transport: makeDiscoveryTransport(ATLASSIAN_V2_PILOT),
    resolveDns: PUBLIC_IP,
  })
  if (!outcome.ok) throw new Error(`discovery failed: ${outcome.error.kind}`)
  return outcome.result
}

const PER_SERVER_URI = buildRemoteRedirectUri({
  origin: ORIGIN,
  variant: 'per-server',
  mode: 'dcr',
  serverName: 'atlassian',
  installNonce: NONCE,
})
const SHARED_URI = buildRemoteRedirectUri({ origin: ORIGIN, variant: 'shared' })

/** Register through the real client and return the parsed response it hands back. */
async function registeredResponse(
  requestedUri: string,
  echoed: unknown | 'omit'
): Promise<{ requested: string[]; response: DcrRegistrationResponse }> {
  const discovery = await atlassianDiscovery()
  const request = buildDcrRequest(discovery, {
    clientMode: 'public',
    redirectUris: [requestedUri],
  })
  const body: Record<string, unknown> = { ...DCR_PUBLIC_REGISTRATION_RESPONSE }
  if (echoed === 'omit') delete body.redirect_uris
  else body.redirect_uris = echoed
  const endpoint = discovery.endpoints.registration
  if (!endpoint) throw new Error('fixture AS has no registration endpoint')
  const { transport } = makeDcrTransport({
    registrationEndpoint: endpoint,
    responseJson: JSON.stringify(body),
  })
  const outcome = await registerDynamicClient(
    { transport, resolveDns: PUBLIC_IP },
    endpoint,
    request
  )
  if (!outcome.ok) throw new Error(`registration failed: ${outcome.error.kind}`)
  return { requested: request.redirect_uris, response: outcome.response }
}

describe('verifyDcrRedirectUris — per-server (required, exact)', () => {
  it('exact echo → ok', async () => {
    const r = await registeredResponse(PER_SERVER_URI, [PER_SERVER_URI])
    expect(verifyDcrRedirectUris({ variant: 'per-server', ...r })).toEqual({ ok: true })
  })

  it('absent → redirect_uris_missing', async () => {
    const r = await registeredResponse(PER_SERVER_URI, 'omit')
    expect(verifyDcrRedirectUris({ variant: 'per-server', ...r })).toEqual({
      ok: false,
      reason: 'redirect_uris_missing',
    })
  })

  const mismatches: Array<{ label: string; echoed: unknown }> = [
    { label: 'the shared URI instead', echoed: [SHARED_URI] },
    {
      label: 'another installation nonce',
      echoed: [PER_SERVER_URI.replace(NONCE, '1'.repeat(8) + NONCE.slice(8))],
    },
    { label: 'a normalized-looking variant (trailing slash)', echoed: [`${PER_SERVER_URI}/`] },
    { label: 'a case-changed variant', echoed: [PER_SERVER_URI.toUpperCase()] },
    { label: 'an extra URI', echoed: [PER_SERVER_URI, SHARED_URI] },
    { label: 'the right URI duplicated', echoed: [PER_SERVER_URI, PER_SERVER_URI] },
    { label: 'an empty list', echoed: [] },
    { label: 'a bare string', echoed: PER_SERVER_URI },
    { label: 'a non-string element', echoed: [42] },
  ]
  for (const { label, echoed } of mismatches) {
    it(`${label} → redirect_uris_mismatch`, async () => {
      const r = await registeredResponse(PER_SERVER_URI, echoed)
      expect(verifyDcrRedirectUris({ variant: 'per-server', ...r })).toEqual({
        ok: false,
        reason: 'redirect_uris_mismatch',
      })
    })
  }
})

describe('verifyDcrRedirectUris — per-server treats null as missing', () => {
  it('null → redirect_uris_missing', async () => {
    const r = await registeredResponse(PER_SERVER_URI, null)
    expect(verifyDcrRedirectUris({ variant: 'per-server', ...r })).toEqual({
      ok: false,
      reason: 'redirect_uris_missing',
    })
  })
})

describe('verifyDcrRedirectUris — shared (tolerates absence, rejects a different echo)', () => {
  it('null → ok (same as absent)', async () => {
    const r = await registeredResponse(SHARED_URI, null)
    expect(verifyDcrRedirectUris({ variant: 'shared', ...r })).toEqual({ ok: true })
  })

  it('absent → ok (ASes that do not echo keep working)', async () => {
    const r = await registeredResponse(SHARED_URI, 'omit')
    expect(verifyDcrRedirectUris({ variant: 'shared', ...r })).toEqual({ ok: true })
  })

  it('exact echo → ok', async () => {
    const r = await registeredResponse(SHARED_URI, [SHARED_URI])
    expect(verifyDcrRedirectUris({ variant: 'shared', ...r })).toEqual({ ok: true })
  })

  it('present and different → redirect_uris_mismatch', async () => {
    const r = await registeredResponse(SHARED_URI, ['https://attacker.example/cb'])
    expect(verifyDcrRedirectUris({ variant: 'shared', ...r })).toEqual({
      ok: false,
      reason: 'redirect_uris_mismatch',
    })
  })
})
