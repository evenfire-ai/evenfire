import { beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import request from 'supertest'
import { createApp } from '../app.js'

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

function produceCheckpoint(requestBody: unknown): unknown {
  const output = execFileSync(
    tsx,
    [
      checkpointProducer,
      JSON.stringify({
        request: requestBody,
        destination: {
          kind: 'mcp_server',
          ref: 'mcp-server/weather',
          url: 'http://weather.mcp-server.svc.cluster.local:8080',
        },
        checkedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
      }),
    ],
    { cwd: repositoryRoot, encoding: 'utf8', env: process.env }
  )
  return JSON.parse(output)
}

beforeAll(() => {
  const output = execFileSync(
    tsx,
    [
      delegationProducer,
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
    { cwd: repositoryRoot, encoding: 'utf8', env: process.env }
  )
  token = JSON.parse(output).token as string
})

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
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/action-authority/checkpoint')) {
        checkpointCalls += 1
        const body = JSON.parse(String(init?.body)) as unknown
        if (checkpointCalls === 1) {
          return Response.json(produceCheckpoint(body), { status: 200 })
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
