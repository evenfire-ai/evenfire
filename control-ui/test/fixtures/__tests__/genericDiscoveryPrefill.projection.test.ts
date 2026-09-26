import { describe, expect, it } from 'vitest'
import type { GenericDiscoveryPrefill } from '../../../lib/oauthGeneric.types'
import { GENERIC_PREFILL_CASES } from '../genericDiscoveryPrefill'

/**
 * This is NOT a cross-service contract test — control-api is not importable from
 * control-ui, so nothing here fails when the real producer
 * (`buildGenericDiscoveryPrefill` in control-api/src/oauth/discovery.ts) drifts.
 * That producer contract is pinned by control-api's own tests. What this file
 * guarantees is narrower: each hand-derived `GenericDiscoveryPrefill` fixture equals
 * a LOCAL re-projection of the verbatim raw probe bytes, so a fixture cannot silently
 * encode an invented shape (T1).
 *
 * DRIFT LIMIT: projectPrefill is a HAND MIRROR of buildGenericDiscoveryPrefill
 * (control-api/src/oauth/discovery.ts). control-api is not importable from
 * control-ui, so a change there does NOT fail this test on its own — it only catches
 * fixture-vs-copy drift. Any edit to buildGenericDiscoveryPrefill must be reflected
 * here. The producer carries the reverse pointer.
 */
function projectPrefill(prmJson: string, asJson: string): GenericDiscoveryPrefill {
  const prm = JSON.parse(prmJson) as Record<string, unknown>
  const as = JSON.parse(asJson) as Record<string, unknown>

  const stringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  const definedStringArray = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined

  const codeChallengeMethods = stringArray(as.code_challenge_methods_supported)
  const tokenEndpointAuthMethods = stringArray(as.token_endpoint_auth_methods_supported)
  const grantTypes = stringArray(as.grant_types_supported)
  const scopesSupported =
    definedStringArray(prm.scopes_supported) ?? definedStringArray(as.scopes_supported) ?? []

  const tokenAuthMethod: 'body' | 'basic' =
    tokenEndpointAuthMethods.includes('client_secret_basic') &&
    !tokenEndpointAuthMethods.includes('client_secret_post')
      ? 'basic'
      : 'body'

  const prefill: GenericDiscoveryPrefill = {
    issuer: as.issuer as string,
    endpoints: {
      authorization: as.authorization_endpoint as string,
      token: as.token_endpoint as string,
    },
    scopesSupported,
    capabilities: { codeChallengeMethods, tokenEndpointAuthMethods, grantTypes },
    suggested: {
      usePkce: codeChallengeMethods.includes('S256'),
      tokenAuthMethod,
      // deriveQuirks fail-closed refresh rule: grant_types_supported ∋ refresh_token.
      supportsRefresh: grantTypes.includes('refresh_token'),
    },
  }
  // resource is present only via the PRM path; these pilots all resolve through the PRM.
  if (typeof prm.resource === 'string') prefill.resource = prm.resource
  return prefill
}

describe('generic discovery prefill fixtures match the real probe bytes (T1)', () => {
  for (const { name, prm, as, fixture } of GENERIC_PREFILL_CASES) {
    it(`${name}: fixture equals the producer projection of the raw bytes`, () => {
      expect(fixture).toEqual(projectPrefill(prm, as))
    })
  }

  it('the S256-bearing pilots suggest usePkce:true; the S256-less variant suggests false', () => {
    for (const name of ['notion', 'linear', 'sentry', 'canva']) {
      const c = GENERIC_PREFILL_CASES.find(x => x.name === name)!
      expect(c.fixture.suggested.usePkce).toBe(true)
    }
    expect(
      GENERIC_PREFILL_CASES.find(x => x.name === 'notion-no-s256')!.fixture.suggested.usePkce
    ).toBe(false)
  })

  it('basic auth is suggested only when the AS advertises basic without post', () => {
    expect(
      GENERIC_PREFILL_CASES.find(x => x.name === 'notion-basic')!.fixture.suggested.tokenAuthMethod
    ).toBe('basic')
    expect(
      GENERIC_PREFILL_CASES.find(x => x.name === 'notion')!.fixture.suggested.tokenAuthMethod
    ).toBe('body')
  })
})
