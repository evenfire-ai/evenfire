import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const mockedConfig = vi.hoisted(() => ({
  internalServiceTokens: {} as Record<string, string>,
  hostsNamespace: 'mcp-host',
}))
const mcpJwtMock = vi.hoisted(() => ({ verifyMcpHostAccessJwt: vi.fn() }))

vi.mock('../src/config.js', () => ({ config: mockedConfig }))
vi.mock('../src/utils/auth/mcpHostJwtToken.js', () => mcpJwtMock)

const { requireActionCheckpointCaller } =
  await import('../src/middleware/actionCheckpointCaller.js')

function app() {
  const value = express()
  value.post('/checkpoint', requireActionCheckpointCaller, (req, res) => {
    res.status(200).json(req.actionCheckpointCaller)
  })
  return value
}

describe('requireActionCheckpointCaller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedConfig.internalServiceTokens = {
      'rpc-proxy': 'rpc-proxy-token-1234567890',
      'external-rest-api': 'external-token-1234567890',
    }
  })

  it.each([
    [
      'HCC host',
      {
        recipeNamespace: 'mcp-host',
        recipeName: 'standalone',
        hostRefs: ['chatllm'],
      },
      { type: 'host', logicalId: 'mcp-host/chatllm' },
    ],
    [
      'WRC workflow recipe',
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'report-recipe',
        hostRefs: ['sandbox-recipes/report-recipe'],
      },
      { type: 'workflow_recipe', logicalId: 'sandbox-recipes/report-recipe' },
    ],
  ])(
    'composes the existing mcp-host runtime JWT verifier for %s',
    async (_label, claims, resource) => {
      mcpJwtMock.verifyMcpHostAccessJwt.mockReturnValue({
        sub: `${claims.recipeNamespace}/${claims.recipeName}`,
        scope: 'workflow:approval:request',
        workflowControlScopes: [],
        iss: 'control-api',
        aud: 'workflow-approvals',
        jti: 'jti',
        exp: 4_102_444_800,
        ...claims,
      })

      const response = await request(app())
        .post('/checkpoint')
        .set('authorization', 'Bearer runtime-access-token')

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        service: 'mcp-host',
        trustPlane: 'mcp_host_runtime_jwt',
        permittedResource: resource,
      })
    }
  )

  it('rejects an ambiguous mcp-host runtime binding', async () => {
    mcpJwtMock.verifyMcpHostAccessJwt.mockReturnValue({
      recipeNamespace: 'mcp-host',
      recipeName: 'standalone',
      hostRefs: ['chatllm', 'other'],
    })

    await request(app())
      .post('/checkpoint')
      .set('authorization', 'Bearer runtime-access-token')
      .expect(401, { error: 'Unauthorized' })
  })

  it('composes the existing rpc-proxy service-token verifier', async () => {
    const response = await request(app())
      .post('/checkpoint')
      .set('authorization', 'Bearer rpc-proxy-token-1234567890')
      .set('x-service-token', 'rpc-proxy')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      service: 'rpc-proxy',
      trustPlane: 'internal_service_token',
    })
  })

  it.each([
    ['missing credentials', undefined, undefined],
    ['wrong rpc-proxy token', 'rpc-proxy', 'wrong-token-that-is-long-enough'],
    ['unregistered caller plane', 'external-rest-api', 'external-token-1234567890'],
  ])('rejects %s', async (_label, service, token) => {
    let pending = request(app()).post('/checkpoint')
    if (service) pending = pending.set('x-service-token', service)
    if (token) pending = pending.set('authorization', `Bearer ${token}`)
    await pending.expect(401, { error: 'Unauthorized' })
  })
})
