import { afterEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { config } from '../src/config.js'
import { ALL_MCP_HOST_CONTROL_SCOPES } from '../src/utils/auth/mcpHostJwtToken.js'
import { MockGateway } from './mockGateway.js'

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

function internalControlSecretForIssuer(iss: string): string {
  return iss === 'hcc'
    ? config.internalControlJwtHccHmacSecret
    : config.internalControlJwtWrcHmacSecret
}

function signInternalControlJwt(iss: string): string {
  return jwt.sign(
    {
      iss,
      aud: 'control-api',
      sub: `${iss}-provisioner`,
    },
    internalControlSecretForIssuer(iss),
    {
      algorithm: 'HS256',
      expiresIn: 60,
      jwtid: `${iss}-error-test-jti`,
    }
  )
}

describe('routes/auth/mcp-host issue error handling', () => {
  afterEach(() => {
    vi.doUnmock('../src/utils/auth/mcpHostJwtToken.js')
  })

  it('delegates unexpected issuance failures to the app error handler', async () => {
    vi.resetModules()
    vi.doMock('../src/utils/auth/mcpHostJwtToken.js', async importOriginal => {
      const actual = await importOriginal<typeof import('../src/utils/auth/mcpHostJwtToken.js')>()
      return {
        ...actual,
        issueMcpHostAccessJwt: vi.fn(() => {
          throw new Error('issuance failed')
        }),
      }
    })

    const { createApp } = await import('../src/app.js')
    const app = createApp(new MockGateway('mcp-server') as never)

    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/test-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({
        includeMcpHostControlToken: true,
        workflowControlScopes: [...ALL_MCP_HOST_CONTROL_SCOPES],
      })

    expect(res.status).toBe(500)
    expect(res.body.error).toBe('Internal Server Error')
  })
})
