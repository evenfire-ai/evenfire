import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { hashActionTarget } from '../../../packages/action-context-contracts'
import { createWfcAuthorityCheckpointer, parseWfcActionAuthority } from './actionAuthority'

const USER = '11111111-1111-4111-8111-111111111111'
const SID = '22222222-2222-4222-8222-222222222222'
const JTI = '33333333-3333-4333-8333-333333333333'
const NOW = Math.floor(Date.now() / 1000)
const TARGET = {
  sharedFileSystemNamespace: 'mcp-host',
  sharedFileSystemName: 'mission',
  relationshipInstanceId: 'rel1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  canonicalRelativePath: 'docs/plan.md',
}

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
        target: TARGET,
        targetHash: hashActionTarget(TARGET),
        accessPathId: 'ap1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        authorizationRevision: 'ar1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        pathKind: 'direct',
        effectiveTeamId: null,
        behaviorBindingHash: 'bh2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      sourceIssuedAt: NOW - 1,
      sourceExpiresAt: NOW + 300,
    },
    { sub: USER, iat: NOW, exp: NOW + 300, name: 'mission', namespace: 'mcp-host' }
  )!
}

function allowedResponse(overrides: Record<string, unknown> = {}) {
  const binding = authority().binding
  const repositoryRoot = resolve(process.cwd(), '..')
  const output = execFileSync(
    resolve(repositoryRoot, 'rpc-proxy/node_modules/.bin/tsx'),
    [
      resolve(
        repositoryRoot,
        'control-api/test/fixtures/emitActionAuthorityCheckpointV2Fixture.ts'
      ),
      JSON.stringify({
        request: {
          version: 2,
          principal: { sub: USER, sid: SID, sessionVersion: 4 },
          delegationJti: JTI,
          resource: binding.resource,
          operationId: binding.operationId,
          target: binding.target,
          targetHash: binding.targetHash,
          accessPathId: binding.accessPathId,
          authorizationRevision: binding.authorizationRevision,
          behaviorBindingHash: binding.behaviorBindingHash,
          domain: {
            service: 'workspace-files-controller',
            resource: binding.resource,
            targetHash: binding.targetHash,
          },
        },
        destination: null,
        checkedAt: new Date().toISOString(),
      }),
    ],
    { cwd: repositoryRoot, encoding: 'utf8' }
  )
  return { ...JSON.parse(output), ...overrides }
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
      return new Response(JSON.stringify(allowedResponse()), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await createWfcAuthorityCheckpointer({
      baseUrl: 'http://control-api:8090',
      serviceToken: 'wfc-service-token',
      timeoutMs: 1000,
    })(value, { operationId: value.binding.operationId, target: value.binding.target })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    ['unknown keys', { ...allowedResponse(), internal: true }, 200],
    [
      'an invalid denied union arm',
      { ...allowedResponse(), status: 'denied', code: 'forbidden', destination: null },
      403,
    ],
  ])('fails closed on a producer response with %s', async (_label, body, status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status }))
    )
    const value = authority()
    await expect(
      createWfcAuthorityCheckpointer({
        baseUrl: 'http://control-api:8090',
        serviceToken: 'wfc-service-token',
        timeoutMs: 1000,
      })(value, { operationId: value.binding.operationId, target: value.binding.target })
    ).rejects.toMatchObject({ status: 503, code: 'not_mounted' })
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
      vi.fn(async () => new Response(JSON.stringify(allowedResponse()), { status: 200 }))
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
    for (const validUntil of ['not-a-date', 123]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () => new Response(JSON.stringify(allowedResponse({ validUntil })), { status: 200 })
        )
      )
      await expect(
        createWfcAuthorityCheckpointer({
          baseUrl: 'http://control-api:8090',
          serviceToken: 'wfc-service-token',
          timeoutMs: 1000,
        })(value, { operationId: value.binding.operationId, target: value.binding.target })
      ).rejects.toMatchObject({ status: 503, code: 'not_mounted' })
    }

    const checkedAt = new Date(Date.now() - 2000).toISOString()
    const expiredAt = new Date(Date.now() - 1000).toISOString()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(allowedResponse({ checkedAt, validUntil: expiredAt })), {
            status: 200,
          })
      )
    )
    await expect(
      createWfcAuthorityCheckpointer({
        baseUrl: 'http://control-api:8090',
        serviceToken: 'wfc-service-token',
        timeoutMs: 1000,
      })(value, { operationId: value.binding.operationId, target: value.binding.target })
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it.each([
    ['authorization revision', { authorizationRevision: `ar1_${'b'.repeat(43)}` }],
    ['behavior binding', { behaviorBindingHash: `bh2_${'b'.repeat(43)}` }],
    ['user', { attribution: { ...allowedResponse().attribution, userId: SID } }],
    ['session', { attribution: { ...allowedResponse().attribution, sid: USER } }],
    ['session version', { attribution: { ...allowedResponse().attribution, sessionVersion: 5 } }],
    [
      'access path',
      { attribution: { ...allowedResponse().attribution, accessPathId: `ap1_${'b'.repeat(43)}` } },
    ],
    [
      'path kind',
      {
        attribution: {
          ...allowedResponse().attribution,
          pathKind: 'team',
          effectiveTeamId: SID,
        },
      },
    ],
    [
      'effective team',
      {
        attribution: {
          ...allowedResponse().attribution,
          pathKind: 'team',
          effectiveTeamId: JTI,
        },
      },
    ],
  ] as const)(
    'rejects an independent %s mismatch before filesystem I/O',
    async (_name, mutation) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(allowedResponse(mutation)), { status: 200 }))
      )
      const value = authority()
      await expect(
        createWfcAuthorityCheckpointer({
          baseUrl: 'http://control-api:8090',
          serviceToken: 'wfc-service-token',
          timeoutMs: 1000,
        })(value, { operationId: value.binding.operationId, target: value.binding.target })
      ).rejects.toMatchObject({ code: 'forbidden' })
    }
  )

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

  it('maps a DOM abort timeout to authority unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('checkpoint timed out', 'AbortError')
      })
    )
    const value = authority()

    await expect(
      createWfcAuthorityCheckpointer({
        baseUrl: 'http://control-api:8090',
        serviceToken: 'wfc-service-token',
        timeoutMs: 1000,
      })(value, { operationId: value.binding.operationId, target: value.binding.target })
    ).rejects.toMatchObject({ status: 503, code: 'not_mounted' })
  })
})
