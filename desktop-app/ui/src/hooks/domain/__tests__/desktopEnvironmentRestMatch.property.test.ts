import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type {
  DesktopRuntimeConfigOption,
  DesktopRuntimeConfigState,
} from '../../../../../src/types'
import { resolveDesktopEnvironmentRestMatch } from '../desktopEnvironmentHandoff'

const endpointArbitrary = fc
  .tuple(
    fc.constantFrom('api.example.test', 'api-alt.example.test'),
    fc.array(fc.constantFrom('api', 'v1', 'v2', 'tenant', 'workspace'), {
      minLength: 1,
      maxLength: 3,
    }),
    fc.constantFrom('', '?tenant=blue', '?tenant=green')
  )
  .map(([host, path, query]) => `https://${host}/${path.join('/')}${query}`)

const decoyKindArbitrary = fc.constantFrom('path', 'query', 'origin')

function withTrailingSlash(endpoint: string): string {
  const url = new URL(endpoint)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url.toString()
}

function withSiblingPath(endpoint: string): string {
  const url = new URL(endpoint)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/sibling`
  return url.toString()
}

function withDifferentQuery(endpoint: string): string {
  const url = new URL(endpoint)
  url.search = url.searchParams.get('tenant') === 'blue' ? '?tenant=green' : '?tenant=blue'
  return url.toString()
}

function withDifferentOrigin(endpoint: string): string {
  const url = new URL(endpoint)
  url.hostname = url.hostname === 'api.example.test' ? 'other.example.test' : 'api.example.test'
  return url.toString()
}

function option(
  id: string,
  externalRestApiBaseUrl: string,
  source: DesktopRuntimeConfigOption['source'] = 'file'
): DesktopRuntimeConfigOption {
  return {
    id,
    label: id,
    source,
    configPath: null,
    externalRestApiBaseUrl,
    rpcProxyBaseUrl: 'https://rpc.example.test',
    appName: id,
  }
}

function configState(
  options: DesktopRuntimeConfigOption[],
  input: { configured?: boolean; activeRestEndpoint?: string } = {}
): DesktopRuntimeConfigState {
  return {
    configured: input.configured ?? true,
    isLocalhost: false,
    selectorVisible: true,
    activeOptionId: null,
    currentConfig: input.activeRestEndpoint
      ? {
          externalRestApiBaseUrl: input.activeRestEndpoint,
          rpcProxyBaseUrl: 'https://current-rpc.example.test',
        }
      : undefined,
    envKey: 'current-000000000000',
    storagePath: '/profiles/current.json',
    options,
  }
}

function expectSavedDecision(
  decision: ReturnType<typeof resolveDesktopEnvironmentRestMatch>,
  expectedId: string
) {
  expect(decision).toMatchObject({ kind: 'saved', option: { id: expectedId } })
}

describe('desktop REST handoff match properties', () => {
  it('keeps a unique exact saved profile stable across option order and unrelated profiles', () => {
    const generatedCases = endpointArbitrary.chain(link =>
      fc.array(decoyKindArbitrary, { maxLength: 6 }).chain(kinds => {
        const options = [option('exact-target', withTrailingSlash(link))]
        kinds.forEach((kind, index) => {
          const endpoint =
            kind === 'path'
              ? withSiblingPath(link)
              : kind === 'query'
                ? withDifferentQuery(link)
                : withDifferentOrigin(link)
          options.push(option(`decoy-${index}`, endpoint))
        })
        return fc
          .shuffledSubarray(options, {
            minLength: options.length,
            maxLength: options.length,
          })
          .map(shuffled => ({ link, options, shuffled }))
      })
    )

    fc.assert(
      fc.property(generatedCases, ({ link, options, shuffled }) => {
        const expected = resolveDesktopEnvironmentRestMatch(configState(options), link)
        const reordered = resolveDesktopEnvironmentRestMatch(configState(shuffled), link)
        const withUnrelated = resolveDesktopEnvironmentRestMatch(
          configState([...shuffled, option('unrelated', withDifferentOrigin(link))]),
          link
        )

        expectSavedDecision(expected, 'exact-target')
        expect(reordered).toEqual(expected)
        expect(withUnrelated).toEqual(expected)
      }),
      { numRuns: 20000 }
    )
  })

  it('treats trailing slashes as equivalent while keeping query variants distinct', () => {
    fc.assert(
      fc.property(endpointArbitrary, link => {
        const exact = resolveDesktopEnvironmentRestMatch(
          configState([option('exact-target', link)]),
          withTrailingSlash(link)
        )
        const queryConflict = resolveDesktopEnvironmentRestMatch(
          configState([option('query-sibling', withDifferentQuery(link))]),
          link
        )
        const pathConflict = resolveDesktopEnvironmentRestMatch(
          configState([option('path-sibling', withSiblingPath(link))]),
          link
        )

        expectSavedDecision(exact, 'exact-target')
        expect(queryConflict.kind).toBe('path-conflict')
        expect(pathConflict.kind).toBe('path-conflict')
      }),
      { numRuns: 5000 }
    )
  })

  it('reports ambiguity when two profiles normalize to the linked endpoint', () => {
    fc.assert(
      fc.property(endpointArbitrary, link => {
        const decision = resolveDesktopEnvironmentRestMatch(
          configState([
            option('exact-one', link),
            option('exact-two', withTrailingSlash(link)),
            option('unrelated', withDifferentOrigin(link)),
          ]),
          link
        )

        expect(decision.kind).toBe('ambiguous')
      }),
      { numRuns: 3000 }
    )
  })

  it('gives a same-origin Localhost option precedence over saved exact matches', () => {
    fc.assert(
      fc.property(endpointArbitrary, fc.boolean(), (link, useReservedId) => {
        const localhost = option(
          useReservedId ? '__localhost__' : 'local-profile',
          withSiblingPath(link),
          useReservedId ? 'file' : 'localhost'
        )
        const decision = resolveDesktopEnvironmentRestMatch(
          configState([option('exact-target', link), localhost]),
          link
        )

        expect(decision).toMatchObject({ kind: 'localhost', option: { id: localhost.id } })
      }),
      { numRuns: 3000 }
    )
  })

  it('prefers the configured active endpoint and ignores an unconfigured current URL', () => {
    fc.assert(
      fc.property(endpointArbitrary, link => {
        const active = resolveDesktopEnvironmentRestMatch(
          configState([option('exact-one', link), option('exact-two', withTrailingSlash(link))], {
            activeRestEndpoint: withTrailingSlash(link),
          }),
          link
        )
        const unconfigured = resolveDesktopEnvironmentRestMatch(
          configState([], { configured: false, activeRestEndpoint: link }),
          link
        )

        expect(active.kind).toBe('active')
        expect(unconfigured.kind).toBe('setup')
      }),
      { numRuns: 3000 }
    )
  })

  it('returns setup when the only saved profiles use unrelated origins', () => {
    fc.assert(
      fc.property(endpointArbitrary, link => {
        const decision = resolveDesktopEnvironmentRestMatch(
          configState([option('unrelated', withDifferentOrigin(link))]),
          link
        )

        expect(decision.kind).toBe('setup')
      }),
      { numRuns: 3000 }
    )
  })
})
