import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  hashActionTarget,
  validateActionAuthorityCheckpointResponse,
} from '../../../packages/action-context-contracts/index.cjs'
import {
  createGfsAuthorityCheckpointer,
  parseGfsActionAuthority,
  requireExactGfsAuthority,
} from './actionAuthority'

const USER = '11111111-1111-4111-8111-111111111111'
const SID = '22222222-2222-4222-8222-222222222222'
const JTI = '33333333-3333-4333-8333-333333333333'
const TARGET = { drive: 'main', resourceId: JTI }

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
        target: TARGET,
        targetHash: hashActionTarget(TARGET),
        accessPathId: 'ap1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        authorizationRevision: 'ar1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        pathKind: 'direct',
        effectiveTeamId: null,
        behaviorBindingHash: 'bh2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      sourceIssuedAt: 90,
      sourceExpiresAt: 200,
    },
    { sub: USER, drive: 'main', iat: 100, exp: 200 }
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
          principal: { sub: USER, sid: SID, sessionVersion: 3 },
          delegationJti: JTI,
          resource: binding.resource,
          operationId: binding.operationId,
          target: binding.target,
          targetHash: binding.targetHash,
          accessPathId: binding.accessPathId,
          authorizationRevision: binding.authorizationRevision,
          behaviorBindingHash: binding.behaviorBindingHash,
          domain: {
            service: 'gfs-controller',
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
  // Every reader test starts from this response: a producer that printed a
  // denied or malformed body must fail the file, not turn the readers' tests
  // into tests of a different input.
  if (validateActionAuthorityCheckpointResponse(JSON.parse(stdout)).status !== 'allowed') {
    throw new Error('the Control API checkpoint producer did not return an allowed checkpoint')
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
      return new Response(JSON.stringify(allowedResponse()), { status: 200 })
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
    await expect(
      createGfsAuthorityCheckpointer({
        baseUrl: 'http://control-api:8090',
        serviceToken: 'gfsc-service-token',
        timeoutMs: 1000,
      })(authority())
    ).rejects.toMatchObject({ code: 'not_mounted' })
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
    for (const validUntil of ['not-a-date', 123]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () => new Response(JSON.stringify(allowedResponse({ validUntil })), { status: 200 })
        )
      )
      await expect(
        createGfsAuthorityCheckpointer({
          baseUrl: 'http://control-api:8090',
          serviceToken: 'gfsc-service-token',
          timeoutMs: 1000,
        })(binding)
      ).rejects.toMatchObject({ code: 'not_mounted' })
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
      createGfsAuthorityCheckpointer({
        baseUrl: 'http://control-api:8090',
        serviceToken: 'gfsc-service-token',
        timeoutMs: 1000,
      })(binding)
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it.each([
    ['authorization revision', () => ({ authorizationRevision: `ar1_${'b'.repeat(43)}` })],
    ['behavior binding', () => ({ behaviorBindingHash: `bh2_${'b'.repeat(43)}` })],
    ['user', (r: AllowedResponse) => ({ attribution: { ...r.attribution, userId: SID } })],
    ['session', (r: AllowedResponse) => ({ attribution: { ...r.attribution, sid: USER } })],
    [
      'session version',
      (r: AllowedResponse) => ({ attribution: { ...r.attribution, sessionVersion: 4 } }),
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

  it('keeps the timeout active while consuming the checkpoint body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                reject(new DOMException('aborted', 'AbortError'))
              })
            }),
        } as Response
      })
    )
    const startedAt = Date.now()

    await expect(
      createGfsAuthorityCheckpointer({
        baseUrl: 'http://control-api:8090',
        serviceToken: 'gfsc-service-token',
        timeoutMs: 20,
      })(authority())
    ).rejects.toMatchObject({ code: 'not_mounted' })
    expect(Date.now() - startedAt).toBeLessThan(500)
  })
})
