import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import {
  ALL_MCP_HOST_CONTROL_SCOPES,
  MCP_HOST_CREDENTIAL_CAPABILITY,
  MCP_HOST_HCC_AUDIENCE,
  MCP_HOST_WORKFLOW_AUDIENCE,
} from '../src/utils/auth/mcpHostJwtToken.js'
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
      jwtid: `${iss}-test-jti-${Date.now()}`,
    }
  )
}

const ISSUE_BODY = {
  includeMcpHostControlToken: true,
  workflowControlScopes: [...ALL_MCP_HOST_CONTROL_SCOPES],
}

describe('routes/auth/mcp-host issue', () => {
  let app: ReturnType<typeof createApp>
  const originalAllowedIssuanceNamespaces = [...config.allowedIssuanceNamespaces]
  const originalHostsNamespace = config.hostsNamespace
  const originalMcpServersNamespace = config.mcpServersNamespace
  const originalSandboxNamespace = config.sandboxNamespace

  beforeEach(() => {
    config.allowedIssuanceNamespaces = [...originalAllowedIssuanceNamespaces]
    config.hostsNamespace = originalHostsNamespace
    config.mcpServersNamespace = originalMcpServersNamespace
    config.sandboxNamespace = originalSandboxNamespace
    app = createApp(new MockGateway('mcp-server') as never)
  })

  afterEach(() => {
    config.allowedIssuanceNamespaces = [...originalAllowedIssuanceNamespaces]
    config.hostsNamespace = originalHostsNamespace
    config.mcpServersNamespace = originalMcpServersNamespace
    config.sandboxNamespace = originalSandboxNamespace
  })

  it('issues mcpHost credentials for WRC in sandbox-recipes', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/test-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send(ISSUE_BODY)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('mcpHostAccessToken')
    expect(res.body).toHaveProperty('mcpHostRefreshToken')
    expect(res.body).toHaveProperty('mcpHostControlToken')
    expect(res.body.channelReaderMcpHostTokens).toBeUndefined()
    expect(res.body.expiresInSeconds).toEqual(
      expect.objectContaining({
        access: expect.any(Number),
        refresh: expect.any(Number),
        control: expect.any(Number),
      })
    )
    expect(res.body.hostRefs).toEqual(['sandbox-recipes/test-recipe'])

    const controlClaims = jwt.decode(res.body.mcpHostControlToken) as Record<string, unknown>
    const accessClaims = jwt.decode(res.body.mcpHostAccessToken) as Record<string, unknown>
    const refreshClaims = jwt.decode(res.body.mcpHostRefreshToken) as Record<string, unknown>
    expect(controlClaims.typ).toBe('service')
    expect(controlClaims.scopes).toEqual(ALL_MCP_HOST_CONTROL_SCOPES)
    expect(accessClaims.workflowControlScopes).toEqual(ALL_MCP_HOST_CONTROL_SCOPES)
    expect(refreshClaims.workflowControlScopes).toEqual(ALL_MCP_HOST_CONTROL_SCOPES)
    expect(controlClaims.scope).toBeUndefined()
    expect(controlClaims.aud).toBe('mcp-host')
    expect(controlClaims.hostRefs).toEqual(['sandbox-recipes/test-recipe'])
  })

  it('does not expose the old workflow auth issuance route', async () => {
    const res = await request(app)
      .post('/api/v1/workflows/sandbox-recipes/test-recipe/auth/issue')
      .set('Authorization', 'Bearer dev-external-rest-api-token')
      .set('x-service-token', 'external-rest-api')

    expect(res.status).toBe(404)
  })

  it('issues mcpHost credentials for HCC in mcp-host with the host name in hostRefs[0]', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/mcp-host/standalone/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({ ...ISSUE_BODY, host: 'trader', hostUid: 'host-uid-trader' })

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('mcpHostAccessToken')
    expect(res.body).toHaveProperty('mcpHostRefreshToken')
    expect(res.body).toHaveProperty('mcpHostControlToken')
    expect(res.body.channelReaderMcpHostTokens).toBeUndefined()
    expect(res.body.hostRefs).toEqual(['trader'])

    const controlClaims = jwt.decode(res.body.mcpHostControlToken) as Record<string, unknown>
    const accessClaims = jwt.decode(res.body.mcpHostAccessToken) as Record<string, unknown>
    const refreshClaims = jwt.decode(res.body.mcpHostRefreshToken) as Record<string, unknown>
    expect(controlClaims.scopes).toEqual(ALL_MCP_HOST_CONTROL_SCOPES)
    expect(controlClaims.scope).toBeUndefined()
    expect(controlClaims.aud).toBe('mcp-host')
    expect(controlClaims.hostRefs).toEqual(['trader'])
    for (const claims of [accessClaims, refreshClaims]) {
      expect(claims.aud).toEqual([MCP_HOST_WORKFLOW_AUDIENCE, MCP_HOST_HCC_AUDIENCE])
      expect(claims.host_uid).toBe('host-uid-trader')
      expect(claims.mcpCapabilities).toEqual([MCP_HOST_CREDENTIAL_CAPABILITY])
      expect(claims.hostRefs).toEqual(['trader'])
    }
    expect(controlClaims.host_uid).toBeUndefined()
    expect(controlClaims.mcpCapabilities).toBeUndefined()
  })

  it('uses the workflowControlScopes declared by the trusted provisioner', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/test-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({ includeMcpHostControlToken: true, workflowControlScopes: ['workflow:list'] })

    expect(res.status).toBe(200)
    const controlClaims = jwt.decode(res.body.mcpHostControlToken) as Record<string, unknown>
    expect(controlClaims.scopes).toEqual(['workflow:list'])
  })

  it('allows an explicitly empty workflowControlScopes declaration for no workflow broker access', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/test-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({ includeMcpHostControlToken: true, workflowControlScopes: [] })

    expect(res.status).toBe(200)
    const controlClaims = jwt.decode(res.body.mcpHostControlToken) as Record<string, unknown>
    expect(controlClaims.scopes).toEqual([])
  })

  it('requires trusted provisioners to declare workflowControlScopes explicitly', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/test-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({ includeMcpHostControlToken: true })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('workflow_control_scopes_required')
  })

  it('rejects invalid or duplicate workflowControlScopes', async () => {
    const invalid = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/test-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({ includeMcpHostControlToken: true, workflowControlScopes: ['workflow:delete'] })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error).toBe('invalid_workflow_control_scopes')

    const duplicate = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/test-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({
        includeMcpHostControlToken: true,
        workflowControlScopes: ['workflow:list', 'workflow:list'],
      })
    expect(duplicate.status).toBe(400)
    expect(duplicate.body.error).toBe('invalid_workflow_control_scopes')
  })

  it('rejects HCC issuance without a host body field', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/mcp-host/standalone/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send(ISSUE_BODY)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('host_required')
  })

  it('rejects HCC issuance whose host violates the RFC1123 label shape', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/mcp-host/standalone/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({ ...ISSUE_BODY, host: 'Not_A_Valid_Host!' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_host_name')
  })

  it('rejects a non-canonical HCC Host name instead of normalizing caller input', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/mcp-host/standalone/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({ ...ISSUE_BODY, host: ' trader ' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_host_name')
  })

  it('rejects HCC issuance without the live Host UID', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/mcp-host/standalone/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({ ...ISSUE_BODY, host: 'trader' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('host_uid_required')
  })

  it('does not let a WRC body upgrade a workflow token into HCC credential authority', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/test-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({
        ...ISSUE_BODY,
        host: 'trader',
        hostUid: 'forged-host-uid',
        mcpCapabilities: [MCP_HOST_CREDENTIAL_CAPABILITY],
        audience: MCP_HOST_HCC_AUDIENCE,
      })

    expect(res.status).toBe(200)
    for (const encoded of [res.body.mcpHostAccessToken, res.body.mcpHostRefreshToken]) {
      const claims = jwt.decode(encoded) as Record<string, unknown>
      expect(claims.aud).toBe(MCP_HOST_WORKFLOW_AUDIENCE)
      expect(claims.host_uid).toBeUndefined()
      expect(claims.mcpCapabilities).toBeUndefined()
    }
  })

  it('rejects HCC issuance with an empty / whitespace host', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/mcp-host/standalone/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({ ...ISSUE_BODY, host: '   ' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('host_required')
  })

  it('requires the control token in the greenfield issuance contract', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/test-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('includeMcpHostControlToken must be true')
  })

  it('rejects HCC for mcp-server because WorkflowRecipe issuance is sandbox-only', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/mcp-server/shared-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send(ISSUE_BODY)

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('provisioner_namespace_mismatch')
  })

  it('rejects HCC for sandbox recipe namespaces', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/test-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send(ISSUE_BODY)

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('provisioner_namespace_mismatch')
  })

  it('rejects a non-standalone HCC issuance target before signing', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/mcp-host/other-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({ ...ISSUE_BODY, host: 'trader', hostUid: 'host-uid-trader' })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('provisioner_target_mismatch')
  })

  it('rejects WRC for mcp-host namespace', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/mcp-host/standalone/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send(ISSUE_BODY)

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('provisioner_namespace_mismatch')
  })

  it('rejects WRC for the shared workflow namespace', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/mcp-server/shared-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send(ISSUE_BODY)

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('provisioner_namespace_mismatch')
  })

  it('uses configured sandbox namespace for WRC issuance binding', async () => {
    config.sandboxNamespace = 'custom-recipes'
    config.allowedIssuanceNamespaces = ['mcp-host', 'custom-recipes']

    const res = await request(app)
      .post('/api/v1/auth/mcp-host/custom-recipes/test-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send(ISSUE_BODY)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('mcpHostAccessToken')
  })

  it('uses configured hosts namespace for HCC issuance binding', async () => {
    config.hostsNamespace = 'agents'
    config.allowedIssuanceNamespaces = ['agents', 'sandbox-recipes']

    const res = await request(app)
      .post('/api/v1/auth/mcp-host/agents/standalone/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({ ...ISSUE_BODY, host: 'chatllm', hostUid: 'host-uid-chatllm' })

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('mcpHostAccessToken')
  })

  it('does not treat configured mcp-server namespace as an HCC issuance target', async () => {
    config.mcpServersNamespace = 'shared-workflows'
    config.allowedIssuanceNamespaces = ['mcp-host', 'shared-workflows', 'sandbox-recipes']

    const res = await request(app)
      .post('/api/v1/auth/mcp-host/shared-workflows/recipe-a/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send(ISSUE_BODY)

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('provisioner_namespace_mismatch')
  })

  it('rejects unknown InternalControl issuers', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/test-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('other')}`)
      .send(ISSUE_BODY)

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })

  it('rejects blank recipe names after route param trimming', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/%20/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send(ISSUE_BODY)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('recipeNamespace and recipeName are required')
  })

  it('rejects namespaces outside CONTROL_API_ALLOWED_ISSUANCE_NAMESPACES', async () => {
    config.allowedIssuanceNamespaces = ['mcp-host']

    const res = await request(app)
      .post('/api/v1/auth/mcp-host/sandbox-recipes/test-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send(ISSUE_BODY)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_issuance_namespace')
  })
})
