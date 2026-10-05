import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type AuthorizationServerMetadata,
  type ProtectedResourceMetadata,
  type RegistrationMode,
  advertisesIssBinding,
  deriveQuirks,
  selectRegistrationMode,
} from '../src/oauth/discovery.js'
import { PILOTS } from './fixtures/remoteOAuthDiscovery.js'

/**
 * T2 property-based coverage for the two pure decision functions of discovery.
 * The classic industry bug is inverting the registration order (D-3); the fuzz
 * blinds that across every combination a human enumeration misses.
 */

// Reference implementation of the normative order, kept deliberately independent
// of the production one so the property catches a reordering in either direction.
// Without RFC 9207 CIMD is never a candidate (its single platform identity can only
// list the shared callback, which relies on `iss`).
function expectedMode(input: {
  hasPreRegisteredClient: boolean
  cimdSupported: boolean
  tokenEndpointAuthMethods: string[]
  hasRegistrationEndpoint: boolean
  issBindingSupported: boolean
}): RegistrationMode {
  if (input.hasPreRegisteredClient) return 'pre-registered'
  if (!input.issBindingSupported) return input.hasRegistrationEndpoint ? 'dcr' : 'manual'
  if (input.cimdSupported && input.tokenEndpointAuthMethods.includes('none')) return 'cimd'
  if (input.hasRegistrationEndpoint) return 'dcr'
  return 'manual'
}

const authMethodArb = fc.subarray(['none', 'client_secret_basic', 'client_secret_post'])

describe('selectRegistrationMode — order pre-reg > CIMD > DCR > manual (T2)', () => {
  it('always returns the first applicable mode in the fixed order', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        authMethodArb,
        fc.boolean(),
        fc.boolean(),
        (
          hasPreRegisteredClient,
          cimdSupported,
          tokenEndpointAuthMethods,
          hasRegistrationEndpoint,
          issBindingSupported
        ) => {
          const input = {
            hasPreRegisteredClient,
            cimdSupported,
            tokenEndpointAuthMethods,
            hasRegistrationEndpoint,
            issBindingSupported,
          }
          expect(selectRegistrationMode(input)).toBe(expectedMode(input))
        }
      )
    )
  })

  it('pre-registered wins over everything else', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        authMethodArb,
        fc.boolean(),
        fc.boolean(),
        (cimd, methods, reg, iss) => {
          expect(
            selectRegistrationMode({
              hasPreRegisteredClient: true,
              cimdSupported: cimd,
              tokenEndpointAuthMethods: methods,
              hasRegistrationEndpoint: reg,
              issBindingSupported: iss,
            })
          ).toBe('pre-registered')
        }
      )
    )
  })

  it('never selects CIMD without RFC 9207', () => {
    fc.assert(
      fc.property(fc.boolean(), authMethodArb, fc.boolean(), (cimd, methods, reg) => {
        expect(
          selectRegistrationMode({
            hasPreRegisteredClient: false,
            cimdSupported: cimd,
            tokenEndpointAuthMethods: methods,
            hasRegistrationEndpoint: reg,
            issBindingSupported: false,
          })
        ).not.toBe('cimd')
      })
    )
  })

  it('CIMD-only AS (no registration endpoint) without RFC 9207 → manual', () => {
    expect(
      selectRegistrationMode({
        hasPreRegisteredClient: false,
        cimdSupported: true,
        tokenEndpointAuthMethods: ['none'],
        hasRegistrationEndpoint: false,
        issBindingSupported: false,
      })
    ).toBe('manual')
  })

  it('CIMD requires BOTH cimdSupported AND `none` (never one alone)', () => {
    // cimdSupported without `none` → not cimd.
    expect(
      selectRegistrationMode({
        hasPreRegisteredClient: false,
        cimdSupported: true,
        tokenEndpointAuthMethods: ['client_secret_post'],
        hasRegistrationEndpoint: true,
        issBindingSupported: true,
      })
    ).toBe('dcr')
    // `none` without cimdSupported → not cimd.
    expect(
      selectRegistrationMode({
        hasPreRegisteredClient: false,
        cimdSupported: false,
        tokenEndpointAuthMethods: ['none'],
        hasRegistrationEndpoint: true,
        issBindingSupported: true,
      })
    ).toBe('dcr')
  })

  it('the 4 real pilots: CIMD only where the AS returns `iss` (Linear, Sentry)', () => {
    const expected = { notion: 'dcr', linear: 'cimd', sentry: 'cimd', canva: 'dcr' } as const
    for (const key of ['notion', 'linear', 'sentry', 'canva'] as const) {
      const as = JSON.parse(PILOTS[key].as.json) as AuthorizationServerMetadata
      expect(
        selectRegistrationMode({
          hasPreRegisteredClient: false,
          cimdSupported: as.client_id_metadata_document_supported === true,
          tokenEndpointAuthMethods: as.token_endpoint_auth_methods_supported ?? [],
          hasRegistrationEndpoint: typeof as.registration_endpoint === 'string',
          issBindingSupported: advertisesIssBinding(as),
        })
      ).toBe(expected[key])
    }
  })
})

describe('deriveQuirks (D-8, T2)', () => {
  const asWith = (grants?: string[]): AuthorizationServerMetadata =>
    ({
      issuer: 'https://as.example.com',
      authorization_endpoint: 'https://as.example.com/authorize',
      token_endpoint: 'https://as.example.com/token',
      ...(grants ? { grant_types_supported: grants } : {}),
    }) as AuthorizationServerMetadata
  const prmWith = (methods?: string[]): ProtectedResourceMetadata => ({
    resource: 'https://r.example.com',
    ...(methods ? { bearer_methods_supported: methods } : {}),
  })

  it('supportsRefresh is fail-closed: true only when refresh_token is advertised', () => {
    fc.assert(
      fc.property(
        fc.option(fc.subarray(['authorization_code', 'refresh_token']), { nil: undefined }),
        grants => {
          const { supportsRefresh } = deriveQuirks(asWith(grants), prmWith())
          expect(supportsRefresh).toBe((grants ?? []).includes('refresh_token'))
        }
      )
    )
  })

  it('bearerInBody: true only for ["body"] without "header"', () => {
    fc.assert(
      fc.property(fc.option(fc.subarray(['header', 'body']), { nil: undefined }), methods => {
        const { bearerInBody } = deriveQuirks(asWith(), prmWith(methods))
        const m = methods ?? []
        expect(bearerInBody).toBe(m.includes('body') && !m.includes('header'))
      })
    )
  })

  it('the 4 real pilots are header-bearer with refresh', () => {
    for (const key of ['notion', 'linear', 'sentry', 'canva'] as const) {
      const as = JSON.parse(PILOTS[key].as.json) as AuthorizationServerMetadata
      const prm = JSON.parse(PILOTS[key].prm.json) as ProtectedResourceMetadata
      expect(deriveQuirks(as, prm)).toEqual({ bearerInBody: false, supportsRefresh: true })
    }
  })
})
