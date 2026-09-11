import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createGfsAuthorityCheckpointer,
  parseGfsActionAuthority,
  requireExactGfsAuthority,
} from './actionAuthority'

const USER = '11111111-1111-4111-8111-111111111111'
const SID = '22222222-2222-4222-8222-222222222222'
const JTI = '33333333-3333-4333-8333-333333333333'

function authority() {
  return parseGfsActionAuthority(
    {
      binding: {
        version: 2,
        userId: USER,
        sid: SID,
        sessionVersion: 3,
        delegationJti: JTI,
        operationId: 'gfs.read',
        resource: {
          environmentId: 'development:local-cluster',
          type: 'gfs_resource',
          canonicalId: `gfs_resource:${JTI}`,
          logicalId: JTI,
          displayName: JTI,
        },
        target: { drive: 'main', resourceId: JTI },
        targetHash: 'ath1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        accessPathId: 'ap1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        authorizationRevision: 'ar1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        pathKind: 'direct',
        effectiveTeamId: null,
        behaviorBindingHash: 'abh1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      sourceIssuedAt: 90,
      sourceExpiresAt: 200,
    },
    { sub: USER, drive: 'main', iat: 100, exp: 200 }
  )!
}

function allowedResponse(overrides: Record<string, unknown> = {}) {
  const binding = authority().binding
  return {
    version: 2,
    status: 'allowed',
    authorizationRevision: binding.authorizationRevision,
    behaviorBindingHash: binding.behaviorBindingHash,
    validUntil: null,
    attribution: {
      userId: USER,
      sid: SID,
      sessionVersion: 3,
      accessPathId: binding.accessPathId,
      pathKind: 'direct',
      effectiveTeamId: null,
    },
    ...overrides,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('gfs v2 live authority', () => {
  it('authenticates the controller separately and preserves exact checkpoint provenance', async () => {
    const binding = authority()
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({
        authorization: 'Bearer gfsc-service-token',
        'x-service-token': 'gfs-controller',
      })
      const request = JSON.parse(String(init.body))
      expect(request).toMatchObject({
        delegationJti: JTI,
        operationId: 'gfs.read',
        accessPathId: binding.binding.accessPathId,
        authorizationRevision: binding.binding.authorizationRevision,
        domain: { service: 'gfs-controller' },
      })
      return new Response(
        JSON.stringify({
          version: 2,
          status: 'allowed',
          authorizationRevision: binding.binding.authorizationRevision,
          behaviorBindingHash: binding.binding.behaviorBindingHash,
          validUntil: null,
          attribution: {
            userId: USER,
            sid: SID,
            sessionVersion: 3,
            accessPathId: binding.binding.accessPathId,
            pathKind: 'direct',
            effectiveTeamId: null,
          },
        }),
        { status: 200 }
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const checkpoint = createGfsAuthorityCheckpointer({
      baseUrl: 'http://control-api:8090',
      serviceToken: 'gfsc-service-token',
      timeoutMs: 1000,
    })
    await checkpoint(binding)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects operation substitution before protected work', () => {
    const binding = authority()
    expect(() =>
      requireExactGfsAuthority(binding, {
        operationId: 'gfs.delete',
        target: binding.binding.target,
      })
    ).toThrow('does not match')
  })

  it('rejects malformed or stale checkpoint validity', async () => {
    const binding = authority()
    for (const validUntil of ['not-a-date', '1970-01-01T00:00:00.000Z', 123]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                version: 2,
                status: 'allowed',
                authorizationRevision: binding.binding.authorizationRevision,
                behaviorBindingHash: binding.binding.behaviorBindingHash,
                validUntil,
                attribution: {
                  userId: USER,
                  sid: SID,
                  sessionVersion: 3,
                  accessPathId: binding.binding.accessPathId,
                  pathKind: 'direct',
                  effectiveTeamId: null,
                },
              }),
              { status: 200 }
            )
        )
      )
      await expect(
        createGfsAuthorityCheckpointer({
          baseUrl: 'http://control-api:8090',
          serviceToken: 'gfsc-service-token',
          timeoutMs: 1000,
        })(binding)
      ).rejects.toMatchObject({ code: 'forbidden' })
    }
  })

  it.each([
    ['authorization revision', { authorizationRevision: `ar1_${'b'.repeat(43)}` }],
    ['behavior binding', { behaviorBindingHash: `bh2_${'b'.repeat(43)}` }],
    ['user', { attribution: { ...allowedResponse().attribution, userId: SID } }],
    ['session', { attribution: { ...allowedResponse().attribution, sid: USER } }],
    ['session version', { attribution: { ...allowedResponse().attribution, sessionVersion: 4 } }],
    [
      'access path',
      { attribution: { ...allowedResponse().attribution, accessPathId: `ap1_${'b'.repeat(43)}` } },
    ],
    ['path kind', { attribution: { ...allowedResponse().attribution, pathKind: 'team' } }],
    ['effective team', { attribution: { ...allowedResponse().attribution, effectiveTeamId: JTI } }],
    ['validity', { validUntil: '1970-01-01T00:00:00.000Z' }],
  ] as const)(
    'rejects an independent %s mismatch before filesystem I/O',
    async (_name, mutation) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(allowedResponse(mutation)), { status: 200 }))
      )
      await expect(
        createGfsAuthorityCheckpointer({
          baseUrl: 'http://control-api:8090',
          serviceToken: 'gfsc-service-token',
          timeoutMs: 1000,
        })(authority())
      ).rejects.toMatchObject({ code: 'forbidden' })
    }
  )

  it('fails closed when Control API is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    await expect(
      createGfsAuthorityCheckpointer({
        baseUrl: 'http://control-api:8090',
        serviceToken: 'gfsc-service-token',
        timeoutMs: 1000,
      })(authority())
    ).rejects.toMatchObject({ code: 'not_mounted' })
  })
})
