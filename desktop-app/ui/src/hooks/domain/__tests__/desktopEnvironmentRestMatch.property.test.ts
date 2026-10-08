import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  desktopRestEndpointOrigin,
  sameDesktopRestEndpoint,
} from '../../../../../src/desktopEnvironmentUrl'
import type {
  DesktopRuntimeConfigOption,
  DesktopRuntimeConfigState,
} from '../../../../../src/types'
import { resolveDesktopEnvironmentRestMatch } from '../desktopEnvironmentHandoff'

const LINK_REST = 'https://api.example.test/api/v1'
const REST_ENDPOINTS = [
  LINK_REST,
  `${LINK_REST}/`,
  `${LINK_REST}?tenant=blue`,
  'https://api.example.test/api/v2',
  'https://other.example.test/api/v1',
]

const profilesArbitrary = fc
  .array(
    fc.record({
      endpointIndex: fc.integer({ min: 0, max: REST_ENDPOINTS.length - 1 }),
      localhost: fc.boolean(),
    }),
    { maxLength: 8 }
  )
  .map(profiles =>
    profiles.map(
      ({ endpointIndex, localhost }, index): DesktopRuntimeConfigOption => ({
        id: `profile-${index}`,
        label: `Profile ${index}`,
        source: localhost ? 'localhost' : 'file',
        configPath: null,
        externalRestApiBaseUrl: REST_ENDPOINTS[endpointIndex]!,
        rpcProxyBaseUrl: 'https://rpc.example.test',
        appName: `Profile ${index}`,
      })
    )
  )

function configState(
  options: DesktopRuntimeConfigOption[],
  activeExactMatch: boolean
): DesktopRuntimeConfigState {
  return {
    configured: true,
    isLocalhost: false,
    selectorVisible: true,
    activeOptionId: activeExactMatch ? (options[0]?.id ?? null) : null,
    currentConfig: {
      externalRestApiBaseUrl: activeExactMatch ? LINK_REST : 'https://current.example.test/api/v1',
      rpcProxyBaseUrl: 'https://current-rpc.example.test',
    },
    envKey: 'current-000000000000',
    storagePath: '/profiles/current.json',
    options,
  }
}

describe('desktop REST handoff match precedence', () => {
  it('always applies the documented precedence to generated saved-profile lists', () => {
    fc.assert(
      fc.property(profilesArbitrary, fc.boolean(), (options, activeExactMatch) => {
        const state = configState(options, activeExactMatch)
        const linkOrigin = desktopRestEndpointOrigin(LINK_REST)
        const localhost = options.find(
          option =>
            option.source === 'localhost' &&
            desktopRestEndpointOrigin(option.externalRestApiBaseUrl) === linkOrigin
        )
        const active =
          state.configured &&
          sameDesktopRestEndpoint(state.currentConfig!.externalRestApiBaseUrl, LINK_REST)
        const saved = options.filter(
          option =>
            option.source !== 'localhost' &&
            sameDesktopRestEndpoint(option.externalRestApiBaseUrl, LINK_REST)
        )
        const sameOriginDifferentEndpoint = options.some(
          option =>
            option.source !== 'localhost' &&
            desktopRestEndpointOrigin(option.externalRestApiBaseUrl) === linkOrigin &&
            !sameDesktopRestEndpoint(option.externalRestApiBaseUrl, LINK_REST)
        )
        const expectedKind = localhost
          ? 'localhost'
          : active
            ? 'active'
            : saved.length > 1
              ? 'ambiguous'
              : saved.length === 1
                ? 'saved'
                : sameOriginDifferentEndpoint
                  ? 'path-conflict'
                  : 'setup'

        const decision = resolveDesktopEnvironmentRestMatch(state, LINK_REST)

        expect(decision.kind).toBe(expectedKind)
        if (decision.kind === 'localhost') expect(decision.option.id).toBe(localhost?.id)
        if (decision.kind === 'saved') expect(decision.option.id).toBe(saved[0]?.id)
      }),
      { numRuns: 20000 }
    )
  })
})
