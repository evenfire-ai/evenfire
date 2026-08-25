import { beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { createApp } from '../src/app.js'
import * as notificationDeliveryQueueService from '../src/services/notificationDeliveryQueueService.js'
import * as userApprovalRequestService from '../src/services/userApprovalRequestService.js'
import * as workflowApprovalMediumLinkSessionService from '../src/services/workflowApprovalMediumLinkSessionService.js'
import * as workflowApprovalMediumOperationalIdentityService from '../src/services/workflowApprovalMediumOperationalIdentityService.js'
import * as workflowApprovalMediumTeamsVerificationService from '../src/services/workflowApprovalMediumTeamsVerificationService.js'
import * as workflowApprovalMediumTelegramProviderEventService from '../src/services/workflowApprovalMediumTelegramProviderEventService.js'
import * as workflowApprovalMediumTelegramVerificationService from '../src/services/workflowApprovalMediumTelegramVerificationService.js'
import * as workflowApprovalProviderDecisionService from '../src/services/workflowApprovalProviderDecisionService.js'
import * as workflowApprovalTelegramChannelGateService from '../src/services/workflowApprovalTelegramChannelGateService.js'
import * as workflowTriggerApprovalService from '../src/services/workflows/workflowTriggerApprovalService.js'
import * as mcpHostJwt from '../src/utils/auth/mcpHostJwtToken.js'
import { MockGateway } from './mockGateway.js'

vi.mock('../src/services/userApprovalRequestService.js')
vi.mock('../src/services/workflowApprovalProviderDecisionService.js', () => ({
  recordProviderApprovalDecision: vi.fn(),
}))
vi.mock('../src/services/workflowApprovalMediumLinkSessionService.js', () => ({
  confirmMediumLinkSessionFromReader: vi.fn(),
}))
vi.mock('../src/services/workflows/workflowTriggerApprovalService.js', () => ({
  createWorkflowTriggerApprovalRequest: vi.fn(),
}))
vi.mock('../src/services/notificationDeliveryQueueService.js', () => ({
  claimNotificationDeliveries: vi.fn(),
  acknowledgeNotificationDelivery: vi.fn(),
  failNotificationDelivery: vi.fn(),
  resolvePendingWorkflowApprovalDelivery: vi.fn(),
}))
vi.mock('../src/services/workflowApprovalMediumOperationalIdentityService.js', () => ({
  findVerifiedOperationalMediumAccount: vi.fn(),
}))
vi.mock('../src/services/workflowApprovalMediumTelegramProviderEventService.js', () => ({
  confirmTelegramProviderEventChallenge: vi.fn(),
}))
vi.mock('../src/services/workflowApprovalMediumTelegramVerificationService.js', () => ({
  userCanAccessTelegramCommunicationChannel: vi.fn(),
}))
vi.mock('../src/services/workflowApprovalMediumTeamsVerificationService.js', () => ({
  addTeamsTargetAssociation: vi.fn(),
  resolveTeamsCommunicationChannelTarget: vi.fn(),
}))
vi.mock('../src/services/workflowApprovalTelegramChannelGateService.js', () => ({
  verifyTelegramOperationalChannelBinding: vi.fn(),
}))
vi.mock('../src/utils/auth/mcpHostJwtToken.js', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/auth/mcpHostJwtToken.js')>(
    '../src/utils/auth/mcpHostJwtToken.js'
  )
  return {
    ...actual,
    consumeMcpHostRefreshJwt: vi.fn(),
  }
})
vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

// Mock DB pool — refresh token revocation now uses DB-backed storage
vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

const NS = 'default'
const RECIPE = 'test-recipe'
const SANDBOX_NS = 'sandbox-recipes'
const SHARED_HOST_NS = 'mcp-host'
const SHARED_HOST = 'chatllm'
const SANDBOX_CALLER_RECIPE = 'caller-recipe'
const SANDBOX_CALLER = `${SANDBOX_NS}/${SANDBOX_CALLER_RECIPE}`
const APPROVAL_ID = '00000000-0000-0000-0000-000000000111'

function issueTestTokens() {
  const access = mcpHostJwt.issueMcpHostAccessJwt(NS, RECIPE)
  const refresh = mcpHostJwt.issueMcpHostRefreshJwt(NS, RECIPE)
  return { accessToken: access.token, refreshToken: refresh.token }
}

function issueSharedHostToken() {
  return mcpHostJwt.issueMcpHostAccessJwt(SHARED_HOST_NS, 'standalone', [SHARED_HOST]).token
}

function issueSandboxCallerToken() {
  return mcpHostJwt.issueMcpHostAccessJwt(SANDBOX_NS, SANDBOX_CALLER_RECIPE, [SANDBOX_CALLER]).token
}

function issueProviderDecisionControlToken(
  scopes: mcpHostJwt.McpHostControlScope[] = ['workflow:approval:decide']
) {
  return mcpHostJwt.issueMcpHostControlJwt(SANDBOX_NS, SANDBOX_CALLER_RECIPE, [SANDBOX_CALLER], {
    scopes,
  }).token
}

async function seedAutonomousWorkflowRecipe(gateway: MockGateway): Promise<void> {
  await gateway.createResource(
    'workflowrecipes',
    {
      metadata: { name: RECIPE },
      spec: { triggers: { onDemand: { allowedActors: ['autonomous'] } } },
    },
    SANDBOX_NS
  )
}

describe('User Approval Request Routes', () => {
  let app: ReturnType<typeof createApp>
  let gateway: MockGateway

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(mcpHostJwt.consumeMcpHostRefreshJwt).mockImplementation(async token =>
      mcpHostJwt.verifyMcpHostRefreshJwt(token)
    )
    vi.mocked(userApprovalRequestService.parseWorkflowTriggerIntent).mockImplementation(
      (payload: unknown) => {
        const record =
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : null
        const metadata =
          record?.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
            ? (record.metadata as Record<string, unknown>)
            : null
        const trigger =
          metadata?.workflowTrigger &&
          typeof metadata.workflowTrigger === 'object' &&
          !Array.isArray(metadata.workflowTrigger)
            ? (metadata.workflowTrigger as Record<string, unknown>)
            : null
        const namespace = typeof trigger?.namespace === 'string' ? trigger.namespace.trim() : ''
        const name = typeof trigger?.name === 'string' ? trigger.name.trim() : ''
        const caller = typeof trigger?.caller === 'string' ? trigger.caller.trim() : ''
        const requesterUserId =
          typeof trigger?.requesterUserId === 'string' ? trigger.requesterUserId.trim() : ''
        return namespace && name && caller
          ? { namespace, name, caller, ...(requesterUserId ? { requesterUserId } : {}) }
          : null
      }
    )
    // status/cancel handlers pre-fetch the recipe binding for the approval id
    // before loading the row, so the binding check can run without leaking row
    // data. Default to a matching sentinel so happy-path tests pass; negative
    // tests override per-case.
    vi.mocked(userApprovalRequestService.getApprovalRecipeBinding).mockResolvedValue({
      recipeNamespace: NS,
      recipeName: RECIPE,
    })
    vi.mocked(
      workflowApprovalTelegramChannelGateService.verifyTelegramOperationalChannelBinding
    ).mockResolvedValue({ ok: true })
    vi.mocked(
      workflowApprovalMediumTelegramVerificationService.userCanAccessTelegramCommunicationChannel
    ).mockResolvedValue(true)
    gateway = new MockGateway('mcp-server')
    app = createApp(gateway as never)
    await seedAutonomousWorkflowRecipe(gateway)
  })

  // Per-handler binding-match: the request body MUST carry recipeNamespace and
  // recipeName, and both MUST equal the JWT claims — otherwise a token issued
  // for one recipe could act on another.
  describe('Binding-match enforcement', () => {
    it('POST /request returns 400 recipe_binding_mismatch when body ns/name differ from claims', async () => {
      const { accessToken } = issueTestTokens()
      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'test-idem-mismatch')
        .send({
          recipeNamespace: 'wrong-ns',
          recipeName: 'wrong-name',
          target: { userId: '00000000-0000-0000-0000-000000000123' },
          payload: { message: 'should not reach allowlist' },
        })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('recipe_binding_mismatch')
    })

    it('POST /request returns 400 when body lacks recipeNamespace/recipeName', async () => {
      const { accessToken } = issueTestTokens()
      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'test-idem-missing')
        .send({
          target: { userId: '00000000-0000-0000-0000-000000000123' },
          payload: { message: 'missing binding' },
        })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/recipeNamespace and recipeName are required/i)
    })
  })

  describe('POST /api/v1/workflow-auth/refresh', () => {
    it('issues new tokens with valid refresh token', async () => {
      const { refreshToken } = issueTestTokens()
      vi.mocked(mcpHostJwt.consumeMcpHostRefreshJwt).mockResolvedValueOnce({
        sub: `${NS}/${RECIPE}`,
        recipeNamespace: NS,
        recipeName: RECIPE,
        hostRefs: [`${NS}/${RECIPE}`],
        scope: 'workflow:approval:refresh',
        workflowControlScopes: ['workflow:list', 'workflow:read'],
        mcpCapabilities: [],
        iss: 'test-issuer',
        aud: 'workflow-approvals',
        jti: 'jti-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
      const res = await request(app)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', `Bearer ${refreshToken}`)
        .send()
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('accessToken')
      expect(res.body).toHaveProperty('refreshToken')
      expect(res.body).toHaveProperty('mcpHostControlToken')
      expect(res.body).toHaveProperty('controlExpiresInSeconds')
    })

    it('preserves HCC authority only from verified refresh lineage and ignores body upgrades', async () => {
      const { refreshToken } = issueTestTokens()
      vi.mocked(mcpHostJwt.consumeMcpHostRefreshJwt).mockResolvedValueOnce({
        sub: 'mcp-host/standalone',
        recipeNamespace: 'mcp-host',
        recipeName: 'standalone',
        hostRefs: ['chatllm'],
        host_uid: 'signed-host-uid',
        scope: 'workflow:approval:refresh',
        workflowControlScopes: ['workflow:list'],
        mcpCapabilities: [mcpHostJwt.MCP_HOST_CREDENTIAL_CAPABILITY],
        iss: 'control-api',
        aud: [mcpHostJwt.MCP_HOST_WORKFLOW_AUDIENCE, mcpHostJwt.MCP_HOST_HCC_AUDIENCE],
        jti: 'hcc-refresh-jti',
        exp: Math.floor(Date.now() / 1000) + 3600,
      })

      const res = await request(app)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', `Bearer ${refreshToken}`)
        .send({ hostUid: 'body-controlled-uid', mcpCapabilities: [] })

      expect(res.status).toBe(200)
      for (const encoded of [res.body.accessToken, res.body.refreshToken]) {
        const claims = jwt.decode(encoded) as Record<string, unknown>
        expect(claims.aud).toEqual([
          mcpHostJwt.MCP_HOST_WORKFLOW_AUDIENCE,
          mcpHostJwt.MCP_HOST_HCC_AUDIENCE,
        ])
        expect(claims.host_uid).toBe('signed-host-uid')
        expect(claims.mcpCapabilities).toEqual([mcpHostJwt.MCP_HOST_CREDENTIAL_CAPABILITY])
      }
      const control = jwt.decode(res.body.mcpHostControlToken) as Record<string, unknown>
      expect(control.host_uid).toBeUndefined()
      expect(control.mcpCapabilities).toBeUndefined()
    })

    it('rejects invalid refresh token', async () => {
      vi.mocked(mcpHostJwt.consumeMcpHostRefreshJwt).mockResolvedValueOnce(null)
      const res = await request(app)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', 'Bearer invalid-token')
        .send()
      expect(res.status).toBe(401)
    })

    it('rejects refresh requests without bearer token', async () => {
      const res = await request(app).post('/api/v1/workflow-auth/refresh').send()
      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Unauthorized')
    })

    it('propagates refresh-token consumption errors to the error handler', async () => {
      vi.mocked(mcpHostJwt.consumeMcpHostRefreshJwt).mockRejectedValueOnce(new Error('db down'))

      const res = await request(app)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', 'Bearer syntactically-present')
        .send()

      expect(res.status).toBe(500)
      expect(res.body.error).toBe('Internal Server Error')
    })

    it('rejects access token used as refresh', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(mcpHostJwt.consumeMcpHostRefreshJwt).mockResolvedValueOnce(null)
      const res = await request(app)
        .post('/api/v1/workflow-auth/refresh')
        .set('Authorization', `Bearer ${accessToken}`)
        .send()
      expect(res.status).toBe(401)
    })
  })

  describe('POST /api/v1/workflow-approvals/request', () => {
    it('rejects without auth', async () => {
      const res = await request(app).post('/api/v1/workflow-approvals/request').send({})
      expect(res.status).toBe(401)
    })

    it('rejects missing Idempotency-Key header', async () => {
      const { accessToken } = issueTestTokens()
      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: { message: 'test' },
        })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Idempotency-Key')
    })

    it('rejects Idempotency-Key values over 256 characters', async () => {
      const { accessToken } = issueTestTokens()
      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'x'.repeat(257))
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: { message: 'test' },
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('maximum length')
      expect(userApprovalRequestService.allowlistCheck).not.toHaveBeenCalled()
    })

    it('rejects requests without exactly one target', async () => {
      const { accessToken } = issueTestTokens()
      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'missing-target')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          payload: { message: 'test' },
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('exactly one')
    })

    it('rejects missing payload.message', async () => {
      const { accessToken } = issueTestTokens()
      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'missing-message')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: {},
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('payload.message is required')
    })

    it('rejects oversized message, metadata, and correlation payloads', async () => {
      const { accessToken } = issueTestTokens()

      const message = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'oversized-message')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: { message: 'x'.repeat(10_001) },
        })
      expect(message.status).toBe(400)
      expect(message.body.error).toContain('10000')

      const metadata = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'oversized-metadata')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: { message: 'test', metadata: { blob: 'x'.repeat(1024) } },
        })
      expect(metadata.status).toBe(400)
      expect(metadata.body.error).toContain('metadata')

      const correlation = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'oversized-correlation')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: { message: 'test' },
          correlation: { blob: 'x'.repeat(1024) },
        })
      expect(correlation.status).toBe(400)
      expect(correlation.body.error).toContain('correlation')
    })

    it('rejects payload with extra fields', async () => {
      const { accessToken } = issueTestTokens()

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'key-1')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: { message: 'test', password: 'secret' },
        })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('unrecognized')
    })

    it('rejects a target userId that is not a UUID before hitting the allowlist query', async () => {
      const { accessToken } = issueTestTokens()

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'bad-user-id')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: 'not-a-uuid' },
          payload: { message: 'test' },
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid userId format, expected UUID')
      expect(userApprovalRequestService.allowlistCheck).not.toHaveBeenCalled()
    })

    it('rejects a target teamId that is not a UUID before hitting the allowlist query', async () => {
      const { accessToken } = issueTestTokens()

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'bad-team-id')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { teamId: 'not-a-uuid' },
          payload: { message: 'test' },
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid teamId format, expected UUID')
      expect(userApprovalRequestService.allowlistCheck).not.toHaveBeenCalled()
    })

    it('returns 403 when target not in allowlist', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(false)

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'key-2')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: { message: 'test' },
        })
      expect(res.status).toBe(403)
    })

    it('returns 409 on idempotency collision', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)
      vi.mocked(userApprovalRequestService.createApprovalRequest).mockResolvedValueOnce({
        id: 'existing-id',
        status: 'pending' as const,
        existing: true,
      })

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'dup-key')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: { message: 'test' },
        })
      expect(res.status).toBe(409)
      expect(res.body.approvalRequestId).toBe('existing-id')
    })

    it('returns 422 idempotency_key_payload_mismatch when service reports mismatch', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)
      vi.mocked(userApprovalRequestService.createApprovalRequest).mockResolvedValueOnce({
        mismatch: true,
        existingId: 'existing-id',
        existingStatus: 'pending' as const,
      })

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'dup-key')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: { message: 'something different' },
        })
      expect(res.status).toBe(422)
      expect(res.body).toMatchObject({
        error: 'idempotency_key_payload_mismatch',
        approvalRequestId: 'existing-id',
        status: 'pending',
      })
    })

    it('creates approval on happy path', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)
      vi.mocked(userApprovalRequestService.createApprovalRequest).mockResolvedValueOnce({
        id: 'new-id',
        status: 'pending' as const,
        expiresAt: '2026-01-01T00:00:00Z',
      })

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'new-key')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: { message: 'Please approve this' },
        })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({
        approvalRequestId: 'new-id',
        status: 'pending',
      })
    })

    it('allows a shared mcp-host to create a sandbox recipe approval bound to its caller key', async () => {
      const accessToken = issueSharedHostToken()
      vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)
      vi.mocked(userApprovalRequestService.triggerGrantCheck).mockResolvedValueOnce(true)
      vi.mocked(userApprovalRequestService.createApprovalRequest).mockResolvedValueOnce({
        id: 'shared-host-id',
        status: 'pending' as const,
        expiresAt: '2026-01-01T00:00:00Z',
      })

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'shared-host-key')
        .send({
          recipeNamespace: SANDBOX_NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: {
            message: 'Please approve this',
            metadata: {
              workflowTrigger: {
                namespace: SANDBOX_NS,
                name: RECIPE,
                caller: SHARED_HOST,
              },
            },
          },
        })

      expect(res.status).toBe(200)
      expect(userApprovalRequestService.allowlistCheck).toHaveBeenCalledWith(
        SANDBOX_NS,
        RECIPE,
        '00000000-0000-0000-0000-000000000001',
        undefined
      )
      expect(userApprovalRequestService.triggerGrantCheck).toHaveBeenCalledWith(
        SANDBOX_NS,
        RECIPE,
        '00000000-0000-0000-0000-000000000001',
        undefined
      )
      expect(userApprovalRequestService.createApprovalRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          recipeNamespace: SANDBOX_NS,
          recipeName: RECIPE,
        })
      )
    })

    it('routes sandbox mcp-host workflow trigger run intent through typed approval creation', async () => {
      const accessToken = issueSandboxCallerToken()
      vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)
      vi.mocked(userApprovalRequestService.triggerGrantCheck).mockResolvedValueOnce(true)
      vi.mocked(userApprovalRequestService.createApprovalRequest).mockResolvedValueOnce({
        id: 'sandbox-caller-id',
        status: 'pending' as const,
        expiresAt: '2026-01-01T00:00:00Z',
      })
      vi.mocked(
        workflowTriggerApprovalService.createWorkflowTriggerApprovalRequest
      ).mockResolvedValueOnce({
        kind: 'approval',
        approvalRequestId: 'sandbox-caller-id',
        status: 'pending',
        expiresAt: '2026-01-01T00:00:00Z',
      })

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'sandbox-caller-key')
        .send({
          recipeNamespace: SANDBOX_NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: {
            message: 'Please approve this',
            metadata: {
              workflowTrigger: {
                namespace: SANDBOX_NS,
                name: RECIPE,
                caller: SANDBOX_CALLER,
              },
            },
          },
          workflowTriggerRunIntent: {
            inputs: { depth: 'standard' },
            intermediateParameters: null,
            outputOverrides: null,
          },
        })

      expect(res.status).toBe(200)
      expect(userApprovalRequestService.triggerGrantCheck).toHaveBeenCalledWith(
        SANDBOX_NS,
        RECIPE,
        '00000000-0000-0000-0000-000000000001',
        undefined
      )
      expect(userApprovalRequestService.createApprovalRequest).not.toHaveBeenCalled()
      expect(
        workflowTriggerApprovalService.createWorkflowTriggerApprovalRequest
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          recipeNamespace: SANDBOX_NS,
          recipeName: RECIPE,
          callerKey: SANDBOX_CALLER,
          runIntent: expect.objectContaining({
            actorType: 'autonomous',
            triggerSource: 'autonomous',
            inputs: { depth: 'standard' },
          }),
        })
      )
    })

    it('creates user run intent for provider chat workflow triggers', async () => {
      const accessToken = issueSharedHostToken()
      const requesterUserId = '00000000-0000-4000-8000-000000000001'
      await gateway.updateResource(
        'workflowrecipes',
        RECIPE,
        {
          metadata: {},
          spec: { triggers: { onDemand: { allowedActors: ['user'] } } },
        },
        SANDBOX_NS
      )
      vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)
      vi.mocked(userApprovalRequestService.triggerGrantCheck).mockResolvedValueOnce(true)
      vi.mocked(
        workflowTriggerApprovalService.createWorkflowTriggerApprovalRequest
      ).mockResolvedValueOnce({
        kind: 'approval',
        approvalRequestId: 'provider-chat-id',
        status: 'pending',
        expiresAt: '2026-01-01T00:00:00Z',
      })

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'provider-chat-key')
        .send({
          recipeNamespace: SANDBOX_NS,
          recipeName: RECIPE,
          target: { userId: requesterUserId },
          payload: {
            message: 'Please approve this',
            metadata: {
              workflowTrigger: {
                namespace: SANDBOX_NS,
                name: RECIPE,
                caller: SHARED_HOST,
                requesterUserId,
              },
            },
          },
          workflowTriggerRunIntent: {
            inputs: { depth: 'standard' },
            intermediateParameters: null,
            outputOverrides: null,
          },
        })

      expect(res.status).toBe(200)
      expect(
        workflowTriggerApprovalService.createWorkflowTriggerApprovalRequest
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          runIntent: expect.objectContaining({
            actorType: 'user',
            actorId: requesterUserId,
            triggerSource: 'onDemand',
            inputs: { depth: 'standard' },
          }),
        })
      )
    })

    it('rejects shared mcp-host approval creation when workflowTrigger.caller is not the host', async () => {
      const accessToken = issueSharedHostToken()

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'shared-host-bad-caller')
        .send({
          recipeNamespace: SANDBOX_NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: {
            message: 'Please approve this',
            metadata: {
              workflowTrigger: {
                namespace: SANDBOX_NS,
                name: RECIPE,
                caller: 'mcp-host/other',
              },
            },
          },
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('recipe_binding_mismatch')
      expect(userApprovalRequestService.createApprovalRequest).not.toHaveBeenCalled()
    })

    it('rejects sandbox approval creation when workflowTrigger target does not match the approval recipe', async () => {
      const accessToken = issueSandboxCallerToken()

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'sandbox-caller-target-mismatch')
        .send({
          recipeNamespace: SANDBOX_NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: {
            message: 'Please approve this',
            metadata: {
              workflowTrigger: {
                namespace: SANDBOX_NS,
                name: 'different-target-recipe',
                caller: SANDBOX_CALLER,
              },
            },
          },
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('recipe_binding_mismatch')
      expect(userApprovalRequestService.allowlistCheck).not.toHaveBeenCalled()
      expect(userApprovalRequestService.triggerGrantCheck).not.toHaveBeenCalled()
      expect(userApprovalRequestService.createApprovalRequest).not.toHaveBeenCalled()
    })

    it('rejects shared mcp-host approval creation when target lacks workflow trigger grant', async () => {
      const accessToken = issueSharedHostToken()
      vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)
      vi.mocked(userApprovalRequestService.triggerGrantCheck).mockResolvedValueOnce(false)

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'shared-host-no-trigger-grant')
        .send({
          recipeNamespace: SANDBOX_NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: {
            message: 'Please approve this',
            metadata: {
              workflowTrigger: {
                namespace: SANDBOX_NS,
                name: RECIPE,
                caller: SHARED_HOST,
              },
            },
          },
        })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Target not authorized to trigger this recipe')
      expect(userApprovalRequestService.triggerGrantCheck).toHaveBeenCalledWith(
        SANDBOX_NS,
        RECIPE,
        '00000000-0000-0000-0000-000000000001',
        undefined
      )
      expect(userApprovalRequestService.createApprovalRequest).not.toHaveBeenCalled()
    })

    it('creates approval requests for team targets', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)
      vi.mocked(userApprovalRequestService.createApprovalRequest).mockResolvedValueOnce({
        id: 'team-id',
        status: 'pending' as const,
        expiresAt: '2026-01-01T00:00:00Z',
      })

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'team-key')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { teamId: '11111111-2222-3333-4444-555555555555' },
          payload: { message: 'Please approve this' },
        })

      expect(res.status).toBe(200)
      expect(userApprovalRequestService.createApprovalRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          targetUserId: undefined,
          targetTeamId: '11111111-2222-3333-4444-555555555555',
        })
      )
    })

    it('rejects requests that include both userId and teamId', async () => {
      const { accessToken } = issueTestTokens()
      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'xor-key')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: {
            userId: '00000000-0000-0000-0000-000000000001',
            teamId: '11111111-2222-3333-4444-555555555555',
          },
          payload: { message: 'test' },
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('exactly one')
    })

    it('passes ttlSeconds through to createApprovalRequest', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)
      vi.mocked(userApprovalRequestService.createApprovalRequest).mockResolvedValueOnce({
        id: 'ttl-id',
        status: 'pending' as const,
        expiresAt: '2026-01-01T00:00:00Z',
      })

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'ttl-key')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: { message: 'Please approve this' },
          ttlSeconds: 120,
        })

      expect(res.status).toBe(200)
      expect(userApprovalRequestService.createApprovalRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          ttlSeconds: 120,
        })
      )
    })

    it('accepts ttlSeconds at the upper boundary (7 days exactly)', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)
      vi.mocked(userApprovalRequestService.createApprovalRequest).mockResolvedValueOnce({
        id: 'ttl-max',
        status: 'pending' as const,
        expiresAt: '2026-01-01T00:00:00Z',
      })

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', 'ttl-max-key')
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: { message: 'approve at the edge' },
          ttlSeconds: 7 * 24 * 60 * 60,
        })

      expect(res.status).toBe(200)
    })

    it.each([
      { label: 'above 7-day cap', ttl: 7 * 24 * 60 * 60 + 1, errMatch: '604800' },
      { label: 'zero', ttl: 0, errMatch: 'positive integer' },
      { label: 'negative', ttl: -1, errMatch: 'positive integer' },
      { label: 'non-integer', ttl: 1.5, errMatch: 'positive integer' },
      { label: 'NaN', ttl: Number.NaN, errMatch: 'positive integer' },
    ])('rejects ttlSeconds $label', async ({ label, ttl, errMatch }) => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.allowlistCheck).mockResolvedValueOnce(true)

      const res = await request(app)
        .post('/api/v1/workflow-approvals/request')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', `ttl-bad-${label}`)
        .send({
          recipeNamespace: NS,
          recipeName: RECIPE,
          target: { userId: '00000000-0000-0000-0000-000000000001' },
          payload: { message: 'bad ttl' },
          ttlSeconds: ttl,
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain(errMatch)
      expect(userApprovalRequestService.createApprovalRequest).not.toHaveBeenCalled()
    })
  })

  describe('POST /api/v1/workflow-approvals/:id/provider-decision', () => {
    it('requires the narrow workflow:approval:decide mcp-host control scope', async () => {
      const token = issueProviderDecisionControlToken(['workflow:trigger'])

      const res = await request(app)
        .post(`/api/v1/workflow-approvals/${APPROVAL_ID}/provider-decision`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          decision: 'approve',
          providerIdentity: {
            medium: 'telegram',
            providerUserId: '123456',
            providerEventId: 'telegram:tg-chat-1:42',
          },
        })

      expect(res.status).toBe(403)
      expect(
        workflowApprovalProviderDecisionService.recordProviderApprovalDecision
      ).not.toHaveBeenCalled()
    })

    it('delegates provider decisions to the control-api authority with caller claims', async () => {
      const token = issueProviderDecisionControlToken()
      vi.mocked(
        workflowApprovalProviderDecisionService.recordProviderApprovalDecision
      ).mockResolvedValueOnce({
        ok: true,
        duplicate: false,
        run: { id: 'run-1', source: 'live', phase: 'Pending' } as never,
      })

      const res = await request(app)
        .post(`/api/v1/workflow-approvals/${APPROVAL_ID}/provider-decision`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          decision: 'approve',
          providerIdentity: {
            medium: 'slack',
            providerUserId: 'U123',
            providerWorkspaceId: 'T123',
            providerChannelId: 'C123',
            providerEventId: 'slack:T123:C123:1700000001.000001',
          },
        })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        success: true,
        duplicate: false,
        run: { id: 'run-1', source: 'live', phase: 'Pending' },
      })
      expect(
        workflowApprovalProviderDecisionService.recordProviderApprovalDecision
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalRequestId: APPROVAL_ID,
          decision: 'approve',
          mediumIdentity: expect.objectContaining({
            medium: 'slack',
            providerUserId: 'U123',
            providerWorkspaceId: 'T123',
            providerChannelId: 'C123',
          }),
          providerEventId: 'slack:T123:C123:1700000001.000001',
          note: null,
        })
      )
      const call = vi.mocked(workflowApprovalProviderDecisionService.recordProviderApprovalDecision)
        .mock.calls[0]![0]
      expect(call.caller.hostRefs).toEqual([SANDBOX_CALLER])
      expect(call.caller.scopes).toContain('workflow:approval:decide')
    })

    it('preserves the Figure D providerTarget.communicationChannelAlias (D1 STRICT bind)', async () => {
      // Regression: parseProviderTarget dropped communicationChannelAlias (it
      // only parsed hostRef/ns/name/botId/botUsername). A Figure D telegram
      // decision carries ONLY the alias, so providerTarget collapsed to null and
      // the authoritative resolveChannelRefByAlias never resolved → every correct
      // approval failed medium_identity_not_verified and the war never approved.
      const token = issueProviderDecisionControlToken()
      vi.mocked(
        workflowApprovalProviderDecisionService.recordProviderApprovalDecision
      ).mockResolvedValueOnce({ ok: true, duplicate: false } as never)

      const res = await request(app)
        .post(`/api/v1/workflow-approvals/${APPROVAL_ID}/provider-decision`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          decision: 'approve',
          providerIdentity: {
            medium: 'telegram',
            providerUserId: '123456',
            providerChannelId: 'tg-chat-1',
            providerChannelType: 'private',
            providerEventId: 'telegram:tg-chat-1:42',
            providerTarget: { communicationChannelAlias: 'ce06da3c' },
          },
        })

      expect(res.status).toBe(200)
      const call = vi.mocked(workflowApprovalProviderDecisionService.recordProviderApprovalDecision)
        .mock.calls[0]![0]
      expect(call.mediumIdentity.providerTarget).toEqual({
        communicationChannelAlias: 'ce06da3c',
      })
    })

    it('requires stable provider channel identity before delegating provider decisions', async () => {
      const token = issueProviderDecisionControlToken()

      const res = await request(app)
        .post(`/api/v1/workflow-approvals/${APPROVAL_ID}/provider-decision`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          decision: 'approve',
          providerIdentity: {
            medium: 'telegram',
            providerUserId: '123456',
            providerEventId: 'telegram:tg-chat-1:42',
          },
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('provider channel identity is required')
      expect(
        workflowApprovalProviderDecisionService.recordProviderApprovalDecision
      ).not.toHaveBeenCalled()
    })

    it('rejects oversized provider identity parts before delegating provider decisions', async () => {
      const token = issueProviderDecisionControlToken()
      const oversized = 'x'.repeat(257)

      const res = await request(app)
        .post(`/api/v1/workflow-approvals/${APPROVAL_ID}/provider-decision`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          decision: 'approve',
          providerIdentity: {
            medium: 'telegram',
            providerUserId: '123456',
            providerChannelId: oversized,
            providerEventId: `telegram:${oversized}:42`,
          },
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('provider identity exceeds maximum length')
      expect(
        workflowApprovalProviderDecisionService.recordProviderApprovalDecision
      ).not.toHaveBeenCalled()
    })
  })

  describe('POST /api/v1/workflow-approval-mediums/resolve', () => {
    it('requires the narrow workflow:approval:resolve mcp-host control scope', async () => {
      const token = issueProviderDecisionControlToken(['workflow:approval:decide'])

      const res = await request(app)
        .post('/api/v1/workflow-approval-mediums/resolve')
        .set('Authorization', `Bearer ${token}`)
        .send({
          providerIdentity: {
            medium: 'telegram',
            providerUserId: '123456',
            providerChannelId: 'tg-chat-1',
            providerChannelType: 'private',
            providerTarget: {
              hostRef: 'agent-a',
              communicationChannelNamespace: 'channels',
              communicationChannelName: 'agent-a-telegram',
            },
          },
        })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('insufficient_scope')
      expect(
        workflowApprovalMediumOperationalIdentityService.findVerifiedOperationalMediumAccount
      ).not.toHaveBeenCalled()
    })

    it('returns the bound Clerum user id for verified Telegram provider identity', async () => {
      const token = issueProviderDecisionControlToken(['workflow:approval:resolve'])
      vi.mocked(
        workflowApprovalMediumOperationalIdentityService.findVerifiedOperationalMediumAccount
      ).mockResolvedValueOnce({
        id: 'medium-account-1',
        userId: '00000000-0000-4000-8000-000000000001',
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'tg-chat-1',
        disabledAt: null,
      })

      const res = await request(app)
        .post('/api/v1/workflow-approval-mediums/resolve')
        .set('Authorization', `Bearer ${token}`)
        .send({
          providerIdentity: {
            medium: 'telegram',
            providerUserId: '123456',
            providerChannelId: 'tg-chat-1',
            providerChannelType: 'private',
            providerTarget: {
              hostRef: 'agent-a',
              communicationChannelNamespace: 'channels',
              communicationChannelName: 'agent-a-telegram',
            },
          },
        })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ userId: '00000000-0000-4000-8000-000000000001' })
      expect(
        workflowApprovalMediumOperationalIdentityService.findVerifiedOperationalMediumAccount
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          medium: 'telegram',
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: 'tg-chat-1',
          providerTarget: expect.objectContaining({
            hostRef: 'agent-a',
            communicationChannelName: 'agent-a-telegram',
          }),
        }),
        undefined,
        // Account lookup remains identity-only; current channel binding and access
        // are enforced immediately afterward against providerTarget.
        { channelBinding: 'identity-only' }
      )
    })

    it('rejects a verified Telegram identity after current channel access is removed', async () => {
      const token = issueProviderDecisionControlToken(['workflow:approval:resolve'])
      vi.mocked(
        workflowApprovalMediumOperationalIdentityService.findVerifiedOperationalMediumAccount
      ).mockResolvedValueOnce({
        id: 'medium-account-1',
        userId: '00000000-0000-4000-8000-000000000001',
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'tg-chat-1',
        disabledAt: null,
      })
      vi.mocked(
        workflowApprovalMediumTelegramVerificationService.userCanAccessTelegramCommunicationChannel
      ).mockResolvedValueOnce(false)

      const res = await request(app)
        .post('/api/v1/workflow-approval-mediums/resolve')
        .set('Authorization', `Bearer ${token}`)
        .send({
          providerIdentity: {
            medium: 'telegram',
            providerUserId: '123456',
            providerChannelId: 'tg-chat-1',
            providerChannelType: 'private',
            providerTarget: {
              hostRef: 'agent-a',
              communicationChannelNamespace: 'channels',
              communicationChannelName: 'agent-a-telegram',
            },
          },
        })

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('communication_channel_access_denied')
    })

    it('requires stable Slack workspace identity', async () => {
      const token = issueProviderDecisionControlToken(['workflow:approval:resolve'])

      const res = await request(app)
        .post('/api/v1/workflow-approval-mediums/resolve')
        .set('Authorization', `Bearer ${token}`)
        .send({
          providerIdentity: {
            medium: 'slack',
            providerUserId: 'U123',
            providerChannelId: 'C123',
          },
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('slack workspace identity is required')
      expect(
        workflowApprovalMediumOperationalIdentityService.findVerifiedOperationalMediumAccount
      ).not.toHaveBeenCalled()
    })

    it('requires stable provider channel identity', async () => {
      const token = issueProviderDecisionControlToken(['workflow:approval:resolve'])

      const res = await request(app)
        .post('/api/v1/workflow-approval-mediums/resolve')
        .set('Authorization', `Bearer ${token}`)
        .send({
          providerIdentity: {
            medium: 'telegram',
            providerUserId: '123456',
          },
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('provider channel identity is required')
      expect(
        workflowApprovalMediumOperationalIdentityService.findVerifiedOperationalMediumAccount
      ).not.toHaveBeenCalled()
    })

    it('rejects oversized provider identity parts before resolving medium accounts', async () => {
      const token = issueProviderDecisionControlToken(['workflow:approval:resolve'])

      const res = await request(app)
        .post('/api/v1/workflow-approval-mediums/resolve')
        .set('Authorization', `Bearer ${token}`)
        .send({
          providerIdentity: {
            medium: 'telegram',
            providerUserId: '123456',
            providerChannelId: 'x'.repeat(257),
          },
        })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('provider identity exceeds maximum length')
      expect(
        workflowApprovalMediumOperationalIdentityService.findVerifiedOperationalMediumAccount
      ).not.toHaveBeenCalled()
    })

    it('does not leak unknown provider identities', async () => {
      const token = issueProviderDecisionControlToken(['workflow:approval:resolve'])
      vi.mocked(
        workflowApprovalMediumOperationalIdentityService.findVerifiedOperationalMediumAccount
      ).mockResolvedValueOnce(null)

      const res = await request(app)
        .post('/api/v1/workflow-approval-mediums/resolve')
        .set('Authorization', `Bearer ${token}`)
        .send({
          providerIdentity: {
            medium: 'telegram',
            providerUserId: 'unknown-user',
            providerChannelId: 'tg-chat-1',
          },
        })

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('medium_account_not_found')
    })
  })

  describe('GET /api/v1/workflow-approvals/:id/status', () => {
    it('rejects malformed approval ids before hitting the service', async () => {
      const { accessToken } = issueTestTokens()
      const res = await request(app)
        .get('/api/v1/workflow-approvals/not-a-uuid/status')
        .set('Authorization', `Bearer ${accessToken}`)

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid approval id format')
      expect(userApprovalRequestService.getStatus).not.toHaveBeenCalled()
    })

    it('returns 404 for unknown approval', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.getStatus).mockResolvedValueOnce(null)
      const res = await request(app)
        .get(`/api/v1/workflow-approvals/${APPROVAL_ID}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
      expect(res.status).toBe(404)
    })

    it('returns 404 when approval binding is missing before status lookup', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.getApprovalRecipeBinding).mockResolvedValueOnce(null)

      const res = await request(app)
        .get(`/api/v1/workflow-approvals/${APPROVAL_ID}/status`)
        .set('Authorization', `Bearer ${accessToken}`)

      expect(res.status).toBe(404)
      expect(userApprovalRequestService.getStatus).not.toHaveBeenCalled()
    })

    it('returns 403 when approval binding does not match token claims', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.getApprovalRecipeBinding).mockResolvedValueOnce({
        recipeNamespace: 'other-ns',
        recipeName: 'other-recipe',
      })

      const res = await request(app)
        .get(`/api/v1/workflow-approvals/${APPROVAL_ID}/status`)
        .set('Authorization', `Bearer ${accessToken}`)

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('binding_mismatch')
      expect(userApprovalRequestService.getStatus).not.toHaveBeenCalled()
    })

    it('returns approval status', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.getStatus).mockResolvedValueOnce({
        id: 'test-id',
        status: 'pending',
        expiresAt: '2026-01-01T00:00:00Z',
        decisionMaker: null,
      } as never)
      const res = await request(app)
        .get(`/api/v1/workflow-approvals/${APPROVAL_ID}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('pending')
      expect(res.body.expiresAt).toBe('2026-01-01T00:00:00Z')
      expect(res.body.decisionMaker).toBeNull()
    })

    it('lets a shared mcp-host poll status when the approval trigger caller matches the host', async () => {
      const accessToken = issueSharedHostToken()
      vi.mocked(userApprovalRequestService.getApprovalRecipeBinding).mockResolvedValueOnce({
        recipeNamespace: SANDBOX_NS,
        recipeName: RECIPE,
        triggerNamespace: SANDBOX_NS,
        triggerName: RECIPE,
        triggerCaller: SHARED_HOST,
      })
      vi.mocked(userApprovalRequestService.getStatus).mockResolvedValueOnce({
        id: 'test-id',
        status: 'approved',
        expiresAt: '2026-01-01T00:00:00Z',
        decisionMaker: null,
      } as never)

      const res = await request(app)
        .get(`/api/v1/workflow-approvals/${APPROVAL_ID}/status`)
        .set('Authorization', `Bearer ${accessToken}`)

      expect(res.status).toBe(200)
      expect(userApprovalRequestService.getStatus).toHaveBeenCalledWith(
        APPROVAL_ID,
        SANDBOX_NS,
        RECIPE
      )
    })
  })

  describe('POST /api/v1/workflow-approvals/:id/cancel', () => {
    it('rejects malformed approval ids before hitting the service', async () => {
      const { accessToken } = issueTestTokens()
      const res = await request(app)
        .post('/api/v1/workflow-approvals/not-a-uuid/cancel')
        .set('Authorization', `Bearer ${accessToken}`)

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid approval id format')
      expect(userApprovalRequestService.cancelRequest).not.toHaveBeenCalled()
    })

    it('returns 404 for unknown approval', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.cancelRequest).mockResolvedValueOnce({
        ok: false,
        error: 'not_found',
      })
      const res = await request(app)
        .post(`/api/v1/workflow-approvals/${APPROVAL_ID}/cancel`)
        .set('Authorization', `Bearer ${accessToken}`)
      expect(res.status).toBe(404)
    })

    it('returns 404 when approval binding is missing before cancel', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.getApprovalRecipeBinding).mockResolvedValueOnce(null)

      const res = await request(app)
        .post(`/api/v1/workflow-approvals/${APPROVAL_ID}/cancel`)
        .set('Authorization', `Bearer ${accessToken}`)

      expect(res.status).toBe(404)
      expect(userApprovalRequestService.cancelRequest).not.toHaveBeenCalled()
    })

    it('returns 403 when cancel binding does not match token claims', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.getApprovalRecipeBinding).mockResolvedValueOnce({
        recipeNamespace: 'other-ns',
        recipeName: 'other-recipe',
      })

      const res = await request(app)
        .post(`/api/v1/workflow-approvals/${APPROVAL_ID}/cancel`)
        .set('Authorization', `Bearer ${accessToken}`)

      expect(res.status).toBe(403)
      expect(res.body.error).toBe('binding_mismatch')
      expect(userApprovalRequestService.cancelRequest).not.toHaveBeenCalled()
    })

    it('returns 409 when cancel fails because the request is no longer pending', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.cancelRequest).mockResolvedValueOnce({
        ok: false,
        error: 'not_pending',
      })

      const res = await request(app)
        .post(`/api/v1/workflow-approvals/${APPROVAL_ID}/cancel`)
        .set('Authorization', `Bearer ${accessToken}`)

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('not_pending')
    })

    it('cancels successfully', async () => {
      const { accessToken } = issueTestTokens()
      vi.mocked(userApprovalRequestService.cancelRequest).mockResolvedValueOnce({ ok: true })
      const res = await request(app)
        .post(`/api/v1/workflow-approvals/${APPROVAL_ID}/cancel`)
        .set('Authorization', `Bearer ${accessToken}`)
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('cancelled')
    })

    it('lets a shared mcp-host cancel when the approval trigger caller matches the host', async () => {
      const accessToken = issueSharedHostToken()
      vi.mocked(userApprovalRequestService.getApprovalRecipeBinding).mockResolvedValueOnce({
        recipeNamespace: SANDBOX_NS,
        recipeName: RECIPE,
        triggerNamespace: SANDBOX_NS,
        triggerName: RECIPE,
        triggerCaller: SHARED_HOST,
      })
      vi.mocked(userApprovalRequestService.cancelRequest).mockResolvedValueOnce({ ok: true })

      const res = await request(app)
        .post(`/api/v1/workflow-approvals/${APPROVAL_ID}/cancel`)
        .set('Authorization', `Bearer ${accessToken}`)

      expect(res.status).toBe(200)
      expect(userApprovalRequestService.cancelRequest).toHaveBeenCalledWith(
        APPROVAL_ID,
        SANDBOX_NS,
        RECIPE,
        expect.objectContaining({ cancelledBy: SHARED_HOST })
      )
    })
  })

  describe('POST /api/v1/workflow-approvals/pending/resolve', () => {
    const providerIdentity = {
      medium: 'telegram',
      providerUserId: '123456',
      providerChannelId: 'telegram-chat-1',
    }

    it('resolves one pending provider approval for the mcp-host caller', async () => {
      const auth = issueProviderDecisionControlToken(['workflow:approval:resolve'])
      vi.mocked(
        notificationDeliveryQueueService.resolvePendingWorkflowApprovalDelivery
      ).mockResolvedValueOnce({
        status: 'found',
        approvalRequestId: APPROVAL_ID,
      })

      const res = await request(app)
        .post('/api/v1/workflow-approvals/pending/resolve')
        .set('Authorization', `Bearer ${auth}`)
        .send({ recipeName: RECIPE, providerIdentity })

      expect(res.status).toBe(200)
      expect(res.body.approvalRequestId).toBe(APPROVAL_ID)
      expect(
        notificationDeliveryQueueService.resolvePendingWorkflowApprovalDelivery
      ).toHaveBeenCalledWith({
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: 'telegram-chat-1',
        hostRef: SANDBOX_CALLER,
        recipeName: RECIPE,
      })
    })

    it('preserves ambiguity instead of selecting the latest pending approval', async () => {
      const auth = issueProviderDecisionControlToken(['workflow:approval:resolve'])
      vi.mocked(
        notificationDeliveryQueueService.resolvePendingWorkflowApprovalDelivery
      ).mockResolvedValueOnce({
        status: 'ambiguous',
      })

      const res = await request(app)
        .post('/api/v1/workflow-approvals/pending/resolve')
        .set('Authorization', `Bearer ${auth}`)
        .send({ recipeName: RECIPE, providerIdentity })

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('pending_workflow_approval_ambiguous')
    })
  })

  describe('mcp-host workflow approval notification delivery routes', () => {
    it('claims notification deliveries for the mcp-host caller using workflow-control JWT', async () => {
      const auth = issueProviderDecisionControlToken(['workflow:approval:resolve'])
      vi.mocked(notificationDeliveryQueueService.claimNotificationDeliveries).mockResolvedValueOnce(
        [
          {
            id: '00000000-0000-0000-0000-000000000222',
            medium: 'telegram',
            providerUserId: '123456',
            providerChannelId: 'telegram-chat-1',
            providerWorkspaceId: null,
            attempts: 1,
            eventType: 'approval.updated',
            payload: {
              approvalRequestId: APPROVAL_ID,
              recipeNamespace: SANDBOX_NS,
              recipeName: RECIPE,
              status: 'cancelled',
            },
          },
        ]
      )

      const res = await request(app)
        .get('/api/v1/workflow-approval-notifications/deliveries')
        .set('Authorization', `Bearer ${auth}`)
        .query({
          medium: 'telegram',
          providerChannelId: ['telegram-chat-1'],
          limit: '10',
        })

      expect(res.status).toBe(200)
      expect(res.body.deliveries).toHaveLength(1)
      expect(notificationDeliveryQueueService.claimNotificationDeliveries).toHaveBeenCalledWith({
        medium: 'telegram',
        providerChannelIds: ['telegram-chat-1'],
        providerWorkspaceId: null,
        hostRef: SANDBOX_CALLER,
        limit: '10',
      })
    })

    it('acknowledges and fails notification deliveries for the mcp-host caller', async () => {
      const auth = issueProviderDecisionControlToken(['workflow:approval:resolve'])
      vi.mocked(
        notificationDeliveryQueueService.acknowledgeNotificationDelivery
      ).mockResolvedValueOnce(true)
      vi.mocked(notificationDeliveryQueueService.failNotificationDelivery).mockResolvedValueOnce(
        true
      )

      const body = {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'telegram-chat-1',
      }
      const ack = await request(app)
        .post(
          '/api/v1/workflow-approval-notifications/deliveries/00000000-0000-0000-0000-000000000222/ack'
        )
        .set('Authorization', `Bearer ${auth}`)
        .send(body)
      const fail = await request(app)
        .post(
          '/api/v1/workflow-approval-notifications/deliveries/00000000-0000-0000-0000-000000000333/fail'
        )
        .set('Authorization', `Bearer ${auth}`)
        .send(body)

      expect(ack.status).toBe(204)
      expect(fail.status).toBe(204)
      expect(notificationDeliveryQueueService.acknowledgeNotificationDelivery).toHaveBeenCalledWith(
        {
          id: '00000000-0000-0000-0000-000000000222',
          medium: 'telegram',
          providerUserId: '123456',
          providerChannelId: 'telegram-chat-1',
          providerWorkspaceId: null,
          hostRef: SANDBOX_CALLER,
        }
      )
      expect(notificationDeliveryQueueService.failNotificationDelivery).toHaveBeenCalledWith({
        id: '00000000-0000-0000-0000-000000000333',
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'telegram-chat-1',
        providerWorkspaceId: null,
        hostRef: SANDBOX_CALLER,
      })
    })
  })

  describe('POST /api/v1/workflow-approval-mediums/telegram/challenges/confirm-provider-event', () => {
    it('confirms Telegram provider-event challenges with the mcp-host workflow-control JWT', async () => {
      const auth = issueProviderDecisionControlToken(['workflow:approval:resolve'])
      vi.mocked(
        workflowApprovalMediumTelegramProviderEventService.confirmTelegramProviderEventChallenge
      ).mockResolvedValueOnce({
        ok: true,
        accountId: 'account-1',
        userEmail: 'user@example.com',
      })

      const providerTarget = {
        hostRef: SHARED_HOST,
        communicationChannelNamespace: 'channels',
        communicationChannelName: 'groupevenfire',
      }
      const res = await request(app)
        .post('/api/v1/workflow-approval-mediums/telegram/challenges/confirm-provider-event')
        .set('Authorization', `Bearer ${auth}`)
        .send({
          code: '123456',
          providerUserId: '123456',
          providerChannelId: '123456',
          providerChannelType: 'private',
          providerTarget,
        })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        ok: true,
        accountId: 'account-1',
        userEmail: 'user@example.com',
      })
      expect(
        workflowApprovalMediumTelegramProviderEventService.confirmTelegramProviderEventChallenge
      ).toHaveBeenCalledWith({
        gateway,
        code: '123456',
        providerUserId: '123456',
        providerChannelId: '123456',
        providerChannelType: 'private',
        providerChannelTitle: null,
        providerChannelHandle: null,
        providerTarget,
      })
    })
  })

  describe('POST /api/v1/workflow-approval-mediums/link-sessions/confirm', () => {
    it('returns 409 when the provider identity is already bound to another user', async () => {
      const auth = issueProviderDecisionControlToken(['workflow:approval:resolve'])
      vi.mocked(
        workflowApprovalMediumLinkSessionService.confirmMediumLinkSessionFromReader
      ).mockResolvedValueOnce({ ok: false, error: 'medium_identity_already_bound' })

      const res = await request(app)
        .post('/api/v1/workflow-approval-mediums/link-sessions/confirm')
        .set('Authorization', `Bearer ${auth}`)
        .send({
          nonce: '123456',
          medium: 'telegram',
          providerUserId: '123456',
          providerChannelId: '123456',
        })

      expect(res.status).toBe(409)
      expect(res.body).toEqual({ ok: false, error: 'medium_identity_already_bound' })
    })

    it('passes the reader channel ref to channel-scoped link-session confirmation', async () => {
      const auth = issueProviderDecisionControlToken(['workflow:approval:resolve'])
      vi.mocked(
        workflowApprovalMediumLinkSessionService.confirmMediumLinkSessionFromReader
      ).mockResolvedValueOnce({ ok: true, account: { id: 'a1' } as never })

      await request(app)
        .post('/api/v1/workflow-approval-mediums/link-sessions/confirm')
        .set('Authorization', `Bearer ${auth}`)
        .send({
          nonce: '123456',
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'D123',
          communicationChannelRef: 'channels/cc-a',
        })

      expect(
        workflowApprovalMediumLinkSessionService.confirmMediumLinkSessionFromReader
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          identity: expect.objectContaining({
            medium: 'slack',
            providerUserId: 'U123',
            providerWorkspaceId: 'T123',
            providerChannelId: 'D123',
            communicationChannelRef: 'channels/cc-a',
          }),
        })
      )
    })

    it('persists and returns the Teams thread reply preference during confirmation', async () => {
      const auth = issueProviderDecisionControlToken(['workflow:approval:resolve'])
      const target = {
        channelNamespace: 'channels',
        channelName: 'teams-a',
        providerWorkspaceId: 'tenant-1',
      }
      vi.mocked(
        workflowApprovalMediumLinkSessionService.confirmMediumLinkSessionFromReader
      ).mockResolvedValueOnce({
        ok: true,
        account: {
          id: 'account-1',
          userId: 'user-1',
          providerUserId: 'teams-user-1',
          providerWorkspaceId: 'tenant-1',
          providerChannelId: 'conversation-1',
        } as never,
        replyInThreads: false,
      })
      vi.mocked(
        workflowApprovalMediumTeamsVerificationService.resolveTeamsCommunicationChannelTarget
      ).mockResolvedValueOnce(target as never)

      const res = await request(app)
        .post('/api/v1/workflow-approval-mediums/link-sessions/confirm')
        .set('Authorization', `Bearer ${auth}`)
        .send({
          nonce: '123456',
          medium: 'teams',
          providerUserId: 'teams-user-1',
          providerWorkspaceId: 'tenant-1',
          providerChannelId: 'conversation-1',
          providerChannelType: 'channel',
          providerChannelTitle: 'General',
          providerTeamId: 'team-1',
          providerTeamsChannelId: 'channel-1',
          serviceUrl: 'https://smba.trafficmanager.net/amer/',
          communicationChannelRef: 'channels/teams-a',
        })

      expect(res.status).toBe(200)
      expect(res.body.replyInThreads).toBe(false)
      expect(
        workflowApprovalMediumTeamsVerificationService.addTeamsTargetAssociation
      ).toHaveBeenCalledWith(
        gateway,
        target,
        expect.objectContaining({
          userId: 'user-1',
          providerChannelId: 'conversation-1',
          replyInThreads: false,
        })
      )
    })

    it('does not overwrite Teams thread replies when the link session omits the preference', async () => {
      const auth = issueProviderDecisionControlToken(['workflow:approval:resolve'])
      const target = {
        channelNamespace: 'channels',
        channelName: 'teams-a',
        providerWorkspaceId: 'tenant-1',
      }
      vi.mocked(
        workflowApprovalMediumLinkSessionService.confirmMediumLinkSessionFromReader
      ).mockResolvedValueOnce({
        ok: true,
        account: {
          id: 'account-1',
          userId: 'user-1',
          providerUserId: 'teams-user-1',
          providerWorkspaceId: 'tenant-1',
          providerChannelId: 'conversation-1',
        } as never,
        replyInThreads: null,
      })
      vi.mocked(
        workflowApprovalMediumTeamsVerificationService.resolveTeamsCommunicationChannelTarget
      ).mockResolvedValueOnce(target as never)

      const res = await request(app)
        .post('/api/v1/workflow-approval-mediums/link-sessions/confirm')
        .set('Authorization', `Bearer ${auth}`)
        .send({
          nonce: '123456',
          medium: 'teams',
          providerUserId: 'teams-user-1',
          providerWorkspaceId: 'tenant-1',
          providerChannelId: 'conversation-1',
          providerChannelType: 'channel',
          providerChannelTitle: 'General',
          communicationChannelRef: 'channels/teams-a',
        })

      expect(res.status).toBe(200)
      expect(
        workflowApprovalMediumTeamsVerificationService.addTeamsTargetAssociation
      ).toHaveBeenCalledWith(
        gateway,
        target,
        expect.not.objectContaining({
          replyInThreads: expect.any(Boolean),
        })
      )
    })

    it('returns 409 when the link-session workspace does not match the reader identity', async () => {
      const auth = issueProviderDecisionControlToken(['workflow:approval:resolve'])
      vi.mocked(
        workflowApprovalMediumLinkSessionService.confirmMediumLinkSessionFromReader
      ).mockResolvedValueOnce({ ok: false, error: 'link_session_workspace_mismatch' })

      const res = await request(app)
        .post('/api/v1/workflow-approval-mediums/link-sessions/confirm')
        .set('Authorization', `Bearer ${auth}`)
        .send({
          nonce: '123456',
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T999',
          providerChannelId: 'D123',
          communicationChannelRef: 'channels/cc-a',
        })

      expect(res.status).toBe(409)
      expect(res.body).toEqual({ ok: false, error: 'link_session_workspace_mismatch' })
    })
  })
})
