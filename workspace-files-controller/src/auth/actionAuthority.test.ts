import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWfcAuthorityCheckpointer, parseWfcActionAuthority } from './actionAuthority'

const USER = '11111111-1111-4111-8111-111111111111'
const SID = '22222222-2222-4222-8222-222222222222'
const JTI = '33333333-3333-4333-8333-333333333333'
const NOW = Math.floor(Date.now() / 1000)

function authority() {
  return parseWfcActionAuthority(
    {
      binding: {
        version: 2,
        userId: USER,
        sid: SID,
        sessionVersion: 4,
        delegationJti: JTI,
        operationId: 'shared_filesystem.read',
        resource: {
          environmentId: 'development:local-cluster',
          type: 'shared_filesystem',
          canonicalId: 'shared_filesystem:mcp-host/mission',
          logicalId: 'mcp-host/mission',
          displayName: 'mission',
        },
        target: {
          sharedFileSystemNamespace: 'mcp-host',
          sharedFileSystemName: 'mission',
          relationshipInstanceId: 'rel1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          canonicalRelativePath: 'docs/plan.md',
        },
        targetHash: 'ath1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        accessPathId: 'ap1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        authorizationRevision: 'ar1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        pathKind: 'direct',
        effectiveTeamId: null,
        behaviorBindingHash: 'abh1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      sourceIssuedAt: NOW - 1,
      sourceExpiresAt: NOW + 300,
    },
    { sub: USER, iat: NOW, exp: NOW + 300, name: 'mission', namespace: 'mcp-host' }
  )!
}

afterEach(() => vi.unstubAllGlobals())

describe('workspace filesystem v2 live authority', () => {
  it('uses the distinct WFC service identity and exact user provenance', async () => {
    const value = authority()
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({
        authorization: 'Bearer wfc-service-token',
        'x-service-token': 'workspace-files-controller',
      })
      expect(JSON.parse(String(init.body))).toMatchObject({
        delegationJti: JTI,
        operationId: 'shared_filesystem.read',
        domain: { service: 'workspace-files-controller' },
      })
      return new Response(
        JSON.stringify({
          version: 2,
          status: 'allowed',
          authorizationRevision: value.binding.authorizationRevision,
          behaviorBindingHash: value.binding.behaviorBindingHash,
          validUntil: null,
          attribution: {
            userId: USER,
            sid: SID,
            sessionVersion: 4,
            accessPathId: value.binding.accessPathId,
            pathKind: 'direct',
            effectiveTeamId: null,
          },
        }),
        { status: 200 }
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    await createWfcAuthorityCheckpointer({
      baseUrl: 'http://control-api:8090',
      serviceToken: 'wfc-service-token',
      timeoutMs: 1000,
    })(value, { operationId: value.binding.operationId, target: value.binding.target })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects target substitution without contacting Control API', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const value = authority()
    await expect(
      createWfcAuthorityCheckpointer({
        baseUrl: 'http://control-api:8090',
        serviceToken: 'wfc-service-token',
        timeoutMs: 1000,
      })(value, {
        operationId: value.binding.operationId,
        target: { ...value.binding.target, canonicalRelativePath: 'other.md' },
      })
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts the same exact target regardless of object key insertion order', async () => {
    const value = authority()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: 2,
              status: 'allowed',
              authorizationRevision: value.binding.authorizationRevision,
              behaviorBindingHash: value.binding.behaviorBindingHash,
              validUntil: null,
              attribution: {
                userId: USER,
                sid: SID,
                sessionVersion: 4,
                accessPathId: value.binding.accessPathId,
                pathKind: 'direct',
                effectiveTeamId: null,
              },
            }),
            { status: 200 }
          )
      )
    )
    const reversed = Object.fromEntries(Object.entries(value.binding.target).reverse())
    await expect(
      createWfcAuthorityCheckpointer({
        baseUrl: 'http://control-api:8090',
        serviceToken: 'wfc-service-token',
        timeoutMs: 1000,
      })(value, { operationId: value.binding.operationId, target: reversed })
    ).resolves.toBeUndefined()
  })

  it('rejects malformed or stale checkpoint validity', async () => {
    const value = authority()
    for (const validUntil of ['not-a-date', '1970-01-01T00:00:00.000Z', 123]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                version: 2,
                status: 'allowed',
                authorizationRevision: value.binding.authorizationRevision,
                behaviorBindingHash: value.binding.behaviorBindingHash,
                validUntil,
                attribution: {
                  userId: USER,
                  sid: SID,
                  sessionVersion: 4,
                  accessPathId: value.binding.accessPathId,
                  pathKind: 'direct',
                  effectiveTeamId: null,
                },
              }),
              { status: 200 }
            )
        )
      )
      await expect(
        createWfcAuthorityCheckpointer({
          baseUrl: 'http://control-api:8090',
          serviceToken: 'wfc-service-token',
          timeoutMs: 1000,
        })(value, { operationId: value.binding.operationId, target: value.binding.target })
      ).rejects.toMatchObject({ code: 'forbidden' })
    }
  })

  it('fails closed on checkpoint outage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    const value = authority()
    await expect(
      createWfcAuthorityCheckpointer({
        baseUrl: 'http://control-api:8090',
        serviceToken: 'wfc-service-token',
        timeoutMs: 1000,
      })(value, { operationId: value.binding.operationId, target: value.binding.target })
    ).rejects.toMatchObject({ code: 'not_mounted' })
  })
})
