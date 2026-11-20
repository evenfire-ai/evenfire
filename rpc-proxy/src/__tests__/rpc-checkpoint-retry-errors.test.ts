import { beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import request from 'supertest'
import {
  type SetupOutcome,
  producerBudgetMs,
  recordSetup,
  runProducerChild,
  setupValue,
} from '../../test/support/producerChild.js'
import { actionAuthorityCheckpointRequest } from '../actionAuthorityV2.js'
import { createApp } from '../app.js'
import type { AuthedRequest } from '../middleware/auth.js'
import { bindRouteActionV2 } from '../routeActionBindingV2.js'
import { verifyUserDelegationV2 } from '../userDelegationV2.js'

const repositoryRoot = resolve(process.cwd(), '..')
const tsx = resolve(repositoryRoot, 'rpc-proxy/node_modules/.bin/tsx')
const delegationProducer = resolve(
  repositoryRoot,
  'control-api/test/fixtures/emitBodyBoundRouteDelegationV2Fixture.ts'
)
const checkpointProducer = resolve(
  repositoryRoot,
  'control-api/test/fixtures/emitActionAuthorityCheckpointV2Fixture.ts'
)

let token = ''
let setupBody: unknown
let checkpointProducerOutput: SetupOutcome<string> | undefined

// Setup, not behaviour under test: two control-api producers run in `tsx` child
// processes, one per distinct input. `beforeAll` runs them, so no test body or
// mocked request starts a process. The checkpoint request is a pure function of
// the delegation claims and the bound action, so `setupBody` is built in process
// the way production builds it, and both cases assert that the first checkpoint
// body production sends equals it: the recorded response answers that request.
// The delegation child is a plain statement of the hook: if it fails the file is
// red, as before. The checkpoint child is recorded and rethrown by
// `checkpointFixture`. Each child is bounded by PRODUCER_CHILD_TIMEOUT_MS. The
// checkpoint, which has a 60 s lifetime, is produced last.
beforeAll(async () => {
  const output = await runProducerChild(
    tsx,
    delegationProducer,
    [
      JSON.stringify({
        operationId: 'mcp.invoke',
        resourceType: 'mcp_server',
        resourceId: 'mcp-server/weather',
        target: {
          serverNamespace: 'mcp-server',
          serverName: 'weather',
          toolName: 'forecast',
        },
      }),
    ],
    { cwd: repositoryRoot, env: process.env }
  )
  token = JSON.parse(output).token as string

  const claims = verifyUserDelegationV2(token)
  if (!claims) throw new Error('producer delegation invalid')
  const bound = bindRouteActionV2(
    {
      route: { path: '/rpc/:serverName' },
      method: 'POST',
      params: { serverName: 'weather' },
      query: {},
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forecast' } },
      userDelegationV2: claims,
    } as unknown as AuthedRequest,
    claims
  )
  setupBody = actionAuthorityCheckpointRequest(claims, bound)

  checkpointProducerOutput = await recordSetup(() =>
    runProducerChild(
      tsx,
      checkpointProducer,
      [
        JSON.stringify({
          request: setupBody,
          destination: {
            kind: 'mcp_server',
            ref: 'mcp-server/weather',
            url: 'http://weather.mcp-server.svc.cluster.local:8080',
          },
          checkedAt: new Date().toISOString(),
          validUntil: new Date(Date.now() + 60_000).toISOString(),
        }),
      ],
      { cwd: repositoryRoot, env: process.env }
    )
  )
}, producerBudgetMs(2))

function checkpointFixture(): unknown {
  return JSON.parse(setupValue(checkpointProducerOutput, 'checkpoint producer output'))
}

describe('mounted v2 MCP retry checkpoint errors', () => {
  it.each([
    {
      name: 'typed unavailable response',
      checkpointResponse: { status: 'authority_unavailable' },
      checkpointStatus: 503,
      expectedStatus: 503,
      expectedBody: { error: 'authority_unavailable' },
      expectedHeaders: {},
    },
    {
      name: 'typed rate-limit response',
      checkpointResponse: { error: 'Too Many Requests', retryAfterSeconds: 9 },
      checkpointStatus: 429,
      expectedStatus: 429,
      expectedBody: { error: 'Too Many Requests', retryAfterSeconds: 9 },
      expectedHeaders: {
        'retry-after': '9',
        'x-ratelimit-limit': '30',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1900000000',
      },
    },
  ])('$name remains canonical after upstream session challenge', async testCase => {
    let checkpointCalls = 0
    let firstCheckpointBody: unknown
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/action-authority/checkpoint')) {
        checkpointCalls += 1
        if (checkpointCalls === 1) {
          firstCheckpointBody = JSON.parse(String(init?.body)) as unknown
          return Response.json(checkpointFixture(), { status: 200 })
        }
        return Response.json(testCase.checkpointResponse, {
          status: testCase.checkpointStatus,
          headers: {
            ...(testCase.checkpointStatus === 429
              ? {
                  'Retry-After': '9',
                  'X-RateLimit-Limit': '30',
                  'X-RateLimit-Remaining': '0',
                  'X-RateLimit-Reset': '1900000000',
                }
              : {}),
            'X-Private-Upstream-Debug': 'must-not-cross-boundary',
          },
        })
      }
      return Response.json({ error: 'session id is required' }, { status: 400 })
    }) as typeof fetch

    try {
      const response = await request(createApp())
        .post('/api/v1/rpc/weather')
        .set('authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forecast' } })

      expect(response.status).toBe(testCase.expectedStatus)
      expect(response.body).toEqual(testCase.expectedBody)
      expect(checkpointCalls).toBe(2)
      expect(firstCheckpointBody).toEqual(setupBody)
      expect(response.headers['x-private-upstream-debug']).toBeUndefined()
      expect(JSON.stringify(response.body)).not.toContain('must-not-cross-boundary')
      for (const [name, value] of Object.entries(testCase.expectedHeaders)) {
        expect(response.headers[name]).toBe(value)
      }
      if (testCase.expectedStatus === 503) {
        expect(response.headers['retry-after']).toBeUndefined()
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
