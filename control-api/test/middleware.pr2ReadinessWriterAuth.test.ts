import { beforeEach, describe, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const mockedConfig = vi.hoisted(() => ({
  internalServiceTokens: {} as Record<string, string>,
}))
const mcpJwtMock = vi.hoisted(() => ({ verifyMcpHostAccessJwt: vi.fn() }))
const internalControlMock = vi.hoisted(() => ({ verifyInternalControlJwt: vi.fn() }))

vi.mock('../src/config.js', () => ({ config: mockedConfig }))
vi.mock('../src/utils/auth/mcpHostJwtToken.js', () => mcpJwtMock)
vi.mock('../src/utils/auth/internalControlToken.js', () => internalControlMock)

const { requirePr2RuntimeReadinessWriter } =
  await import('../src/middleware/pr2ReadinessWriterAuth.js')

function app() {
  const value = express()
  value.post('/evidence', requirePr2RuntimeReadinessWriter, (req, res) => {
    res.status(200).json({ writer: req.pr2RuntimeReadinessWriter })
  })
  return value
}

describe('PR2 runtime readiness writer authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedConfig.internalServiceTokens = {
      'external-rest-api': 'external-rest-token',
      'rpc-proxy': 'rpc-proxy-token1',
      'gfs-controller': 'gfs-controller-token1',
      'workspace-files-controller': 'workspace-files-token1',
    }
    internalControlMock.verifyInternalControlJwt.mockReturnValue(null)
  })

  it.each([
    ['external-rest-api', 'external-rest-token'],
    ['rpc-proxy', 'rpc-proxy-token1'],
    ['gfs-controller', 'gfs-controller-token1'],
    ['workspace-files-controller', 'workspace-files-token1'],
  ])('reuses the exact %s static service identity', async (service, token) => {
    await request(app())
      .post('/evidence')
      .set('authorization', `Bearer ${token}`)
      .set('x-service-token', service)
      .expect(200, { writer: service })
  })

  it('reuses the exact WRC internal-control identity', async () => {
    internalControlMock.verifyInternalControlJwt.mockReturnValue({
      iss: 'wrc',
      sub: 'wrc-provisioner',
    })
    await request(app())
      .post('/evidence')
      .set('authorization', 'Bearer wrc-token')
      .expect(200, { writer: 'workflow-recipes' })
  })

  it('reuses an authenticated mcp-host runtime identity', async () => {
    mcpJwtMock.verifyMcpHostAccessJwt.mockReturnValue({ hostRefs: ['host-a'] })
    await request(app())
      .post('/evidence')
      .set('authorization', 'Bearer mcp-token')
      .expect(200, { writer: 'mcp-host' })
  })

  it.each([
    ['unknown service', 'unknown', 'rpc-proxy-token1'],
    ['sibling token', 'rpc-proxy', 'external-rest-token'],
  ])('rejects %s', async (_label, service, token) => {
    await request(app())
      .post('/evidence')
      .set('authorization', `Bearer ${token}`)
      .set('x-service-token', service)
      .expect(401)
  })
})
