import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  hashActionTarget,
  validateActionAuthorityCheckpointResponse,
} from '../../../packages/action-context-contracts'
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

// Setup, not behaviour under test: the Control API checkpoint producer runs in
// a `tsx` child process. `beforeAll` runs it once, so no test body, mocked
// request or `it.each` table starts a process. The child has its own
// `timeout`; a failed or timed-out child fails the hook, and the file with it.
const PRODUCER_CHILD_TIMEOUT_MS = 240_000
// The child limit, plus 120 s of margin.
const PRODUCER_SETUP_TIMEOUT_MS = PRODUCER_CHILD_TIMEOUT_MS + 120_000
let allowedProducerStdout: string | undefined

function produceAllowed(): string {
  const binding = authority().binding
  const repositoryRoot = resolve(process.cwd(), '..')
  return execFileSync(
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
    { cwd: repositoryRoot, encoding: 'utf8', timeout: PRODUCER_CHILD_TIMEOUT_MS }
  )
}

beforeAll(() => {
  const stdout = produceAllowed()
  // The producer must return an allowed checkpoint that satisfies the contract:
  // the "fails closed" tests below corrupt this response, and they would pass
  // against an empty one.
  if (validateActionAuthorityCheckpointResponse(JSON.parse(stdout)).status !== 'allowed') {
    throw new Error('Control API checkpoint producer did not return an allowed checkpoint')
  }
  allowedProducerStdout = stdout
}, PRODUCER_SETUP_TIMEOUT_MS)

type AllowedResponse = Record<string, unknown> & { attribution: Record<string, unknown> }

function allowedResponse(overrides: Record<string, unknown> = {}): AllowedResponse {
  if (allowedProducerStdout === undefined) {
    throw new Error('the allowed checkpoint producer was not set up in beforeAll')
  }
  return { ...JSON.parse(allowedProducerStdout), ...overrides }
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
    ['unknown keys', (response: AllowedResponse) => ({ ...response, internal: true }), 200],
    [
      'an invalid denied union arm',
      (response: AllowedResponse) => ({
        ...response,
        status: 'denied',
        code: 'forbidden',
        destination: null,
      }),
      403,
    ],
  ] as const)('fails closed on a producer response with %s', async (_label, corrupt, status) => {
    const body = corrupt(allowedResponse())
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
    ['authorization revision', () => ({ authorizationRevision: `ar1_${'b'.repeat(43)}` })],
    ['behavior binding', () => ({ behaviorBindingHash: `bh2_${'b'.repeat(43)}` })],
    ['user', (r: AllowedResponse) => ({ attribution: { ...r.attribution, userId: SID } })],
    ['session', (r: AllowedResponse) => ({ attribution: { ...r.attribution, sid: USER } })],
    [
      'session version',
      (r: AllowedResponse) => ({ attribution: { ...r.attribution, sessionVersion: 5 } }),
    ],
    [
      'access path',
      (r: AllowedResponse) => ({
        attribution: { ...r.attribution, accessPathId: `ap1_${'b'.repeat(43)}` },
      }),
    ],
    [
      'path kind',
      (r: AllowedResponse) => ({
        attribution: { ...r.attribution, pathKind: 'team', effectiveTeamId: SID },
      }),
    ],
    [
      'effective team',
      (r: AllowedResponse) => ({
        attribution: { ...r.attribution, pathKind: 'team', effectiveTeamId: JTI },
      }),
    ],
  ] as const)(
    'rejects an independent %s mismatch before filesystem I/O',
    async (_name, mutation) => {
      const mutated = allowedResponse(mutation(allowedResponse()))
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(mutated), { status: 200 }))
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
