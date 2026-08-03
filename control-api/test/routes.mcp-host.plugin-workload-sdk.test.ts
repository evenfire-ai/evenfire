import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { pool } from '../src/db.js'
import { createMcpHostPluginWorkloadSdkRoutes } from '../src/routes/mcp-host/plugin-workload-sdk.routes.js'
import * as notificationEmitter from '../src/services/notificationEmitter.js'
import * as authorizer from '../src/services/pluginWorkloadSdkAuthorizer.js'
import { issuePluginWorkloadSdkCredentialTicket } from '../src/services/pluginWorkloadSdkCredentialTicket.js'
import * as sdkDb from '../src/services/pluginWorkloadSdkDb.js'
import * as auditor from '../src/services/pluginWorkloadSdkInvocationAuditor.js'
import * as mcpHostJwt from '../src/utils/auth/mcpHostJwtToken.js'

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn(),
  enqueueApprovalRequestedNotification: vi.fn(),
  enqueueApprovalUpdatedNotification: vi.fn(),
  enqueuePluginWorkloadSdkNotification: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/services/pluginWorkloadSdkDb.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/pluginWorkloadSdkDb.js')>(
    '../src/services/pluginWorkloadSdkDb.js'
  )
  return {
    ...actual,
    getInvocationById: vi.fn(),
    getPluginWorkloadSdkAttemptReceipt: vi.fn(),
    getPluginWorkloadSdkProviderAttempt: vi.fn(),
    findGrant: vi.fn(),
    listInvocations: vi.fn(),
    redeemPluginWorkloadSdkCredentialTicketJti: vi.fn(),
    markPluginWorkloadSdkProviderAttemptStatus: vi.fn(),
    resolveRecipientProfiles: vi.fn(),
  }
})

vi.mock('../src/services/pluginWorkloadSdkAuthorizer.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/services/pluginWorkloadSdkAuthorizer.js')
  >('../src/services/pluginWorkloadSdkAuthorizer.js')
  return {
    ...actual,
    authorizePromptBridge: vi.fn(),
    authorizeClientNotification: vi.fn(),
    authorizeListRecipients: vi.fn(),
    reissuePromptBridgeCredentialTicket: vi.fn(),
  }
})

vi.mock('../src/services/pluginWorkloadSdkInvocationAuditor.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/services/pluginWorkloadSdkInvocationAuditor.js')
  >('../src/services/pluginWorkloadSdkInvocationAuditor.js')
  return {
    ...actual,
    markInvocationStatus: vi.fn().mockResolvedValue(true),
  }
})

const NS = 'sandbox-recipes'
const RECIPE = 'sdk-recipe'

function buildApp() {
  const app = express()
  // Mirror app.ts: the production body limit is 1mb, above the SDK's own
  // 128KB content cap so the route-level check is the one that fires.
  app.use(express.json({ limit: '1mb' }))
  app.use(createMcpHostPluginWorkloadSdkRoutes())
  return app
}

function issueSdkToken(scopes: mcpHostJwt.McpHostControlScope[] = ['plugin-workload-sdk']) {
  return mcpHostJwt.issueMcpHostAccessJwt(NS, RECIPE, undefined, {
    workflowControlScopes: scopes,
  }).token
}

const validPromptBody = {
  recipeNamespace: NS,
  recipeName: RECIPE,
  callerRef: 'api',
  bootstrapProvider: 'zai',
  bootstrapModel: 'glm-4.7',
  purpose: 'summarization',
  idempotencyKey: 'key-1',
  messages: [{ role: 'user', content: 'summarize this' }],
}

const validNotificationBody = {
  recipeNamespace: NS,
  recipeName: RECIPE,
  callerRef: 'api',
  eventType: 'lead.followup.due',
  target: { targetRef: 'team.sales' },
  idempotencyKey: 'key-2',
  notification: { title: 'Follow up', body: 'Lead is due' },
}

beforeEach(() => {
  vi.mocked(authorizer.authorizePromptBridge).mockReset()
  vi.mocked(authorizer.reissuePromptBridgeCredentialTicket).mockReset()
  vi.mocked(authorizer.authorizeClientNotification).mockReset()
  vi.mocked(sdkDb.listInvocations).mockReset()
  vi.mocked(auditor.markInvocationStatus).mockReset().mockResolvedValue(true)
  vi.mocked(sdkDb.getInvocationById).mockReset()
  vi.mocked(sdkDb.getPluginWorkloadSdkAttemptReceipt).mockReset()
  vi.mocked(sdkDb.getPluginWorkloadSdkProviderAttempt).mockReset()
  vi.mocked(sdkDb.findGrant).mockReset()
  vi.mocked(sdkDb.redeemPluginWorkloadSdkCredentialTicketJti).mockReset()
  vi.mocked(sdkDb.markPluginWorkloadSdkProviderAttemptStatus).mockReset()
  vi.mocked(notificationEmitter.enqueuePluginWorkloadSdkNotification)
    .mockReset()
    .mockResolvedValue(undefined)
  vi.mocked(sdkDb.redeemPluginWorkloadSdkCredentialTicketJti).mockResolvedValue(true)
  vi.mocked(sdkDb.getPluginWorkloadSdkAttemptReceipt).mockResolvedValue(null)
  vi.mocked(sdkDb.getPluginWorkloadSdkProviderAttempt).mockResolvedValue(null)
  vi.mocked(sdkDb.markPluginWorkloadSdkProviderAttemptStatus).mockResolvedValue(true)
  vi.mocked(authorizer.authorizePromptBridge).mockResolvedValue({
    ok: true,
    value: {
      invocationId: 'inv-1',
      replay: false,
      providerCallRequired: true,
      status: 'in_progress',
      model: 'glm-4.7',
      modelPolicy: null,
      selectedTarget: {
        targetRef: 'primary-zai',
        provider: 'zai',
        model: 'glm-4.7',
        credentialSlot: 'zai-api-key',
      },
      authorizedTargets: [
        {
          targetRef: 'primary-zai',
          provider: 'zai',
          model: 'glm-4.7',
          credentialSlot: 'zai-api-key',
        },
      ],
      attemptGeneration: 1,
      policyRevision: 1,
      policyHash: 'policy-hash',
      maxOutputTokens: null,
    },
  })
  vi.mocked(authorizer.reissuePromptBridgeCredentialTicket).mockResolvedValue({
    ok: true,
    value: {
      invocationId: 'inv-1',
      attemptGeneration: 1,
      targetRef: 'openai-fallback',
      providerAttemptId: '33333333-3333-4333-8333-333333333333',
      providerAttemptIndex: 1,
      credentialTicket: 'signed-fresh-ticket',
      policyRevision: 1,
      policyHash: 'policy-hash',
      expiresInSeconds: 60,
    },
  })
  vi.mocked(authorizer.authorizeClientNotification).mockResolvedValue({
    ok: true,
    value: { notificationId: 'not-1', replay: false, status: 'accepted' },
  })
  vi.mocked(authorizer.authorizeListRecipients)
    .mockReset()
    .mockResolvedValue({
      ok: true,
      value: { allowedUserRefs: ['11111111-1111-4111-8111-111111111111'] },
    })
  vi.mocked(sdkDb.resolveRecipientProfiles)
    .mockReset()
    .mockResolvedValue([
      { userRef: '11111111-1111-4111-8111-111111111111', displayName: 'Ada Lovelace' },
    ])
})

describe('GET /mcp-host/plugin-workload-sdk/capabilities', () => {
  it('advertises the v2 identity contract while a prompt policy is missing', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue(null)

    const res = await request(buildApp())
      .get('/mcp-host/plugin-workload-sdk/capabilities')
      .set('Authorization', `Bearer ${issueSdkToken()}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      contractVersion: 2,
      supportedContractVersions: [1, 2],
      targetAwarePromptBridge: true,
      attemptLedger: true,
      credentialTickets: true,
      policyState: 'missing',
      policyRevision: 0,
      policyHash: null,
      defaultTargetRef: null,
      defaultProvider: null,
      defaultModel: null,
      v2Ready: false,
    })
  })

  it('reports an active target policy as v2-ready', async () => {
    vi.mocked(sdkDb.findGrant).mockResolvedValue({
      id: 'grant-capabilities',
      recipeNamespace: NS,
      recipeName: RECIPE,
      capabilityFamily: 'promptBridge',
      provider: 'openai',
      allowedModels: ['gpt-5.4-mini'],
      allowedEventTypes: [],
      allowedTargetRefs: [],
      allowedUserRefs: [],
      allowedCallers: ['api'],
      quotaLimits: {},
      modelPolicies: {},
      promptTargets: [
        {
          targetRef: 'primary-openai',
          provider: 'openai',
          model: 'gpt-5.4-mini',
          credentialSlot: 'openai-api-key',
        },
      ],
      defaultTargetRef: 'primary-openai',
      policyState: 'active',
      policyRevision: 2,
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    })

    const res = await request(buildApp())
      .get('/mcp-host/plugin-workload-sdk/capabilities')
      .set('Authorization', `Bearer ${issueSdkToken()}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      policyState: 'active',
      policyRevision: 2,
      defaultTargetRef: 'primary-openai',
      defaultProvider: 'openai',
      defaultModel: 'gpt-5.4-mini',
      v2Ready: true,
    })
    expect(res.body.policyHash).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('POST /mcp-host/plugin-workload-sdk/prompt-bridge', () => {
  it('returns 401 without a token', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge')
      .send(validPromptBody)
    expect(res.status).toBe(401)
  })

  it('returns 400 recipe_binding_mismatch when body differs from claims', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ ...validPromptBody, recipeName: 'other-recipe' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('recipe_binding_mismatch')
    expect(authorizer.authorizePromptBridge).not.toHaveBeenCalled()
  })

  it('returns 400 invalid_purpose for a purpose outside the enum', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ ...validPromptBody, purpose: 'jailbreak' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_purpose')
  })

  it('returns 400 invalid_idempotency_key for a malformed key', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ ...validPromptBody, idempotencyKey: 'bad key with spaces!' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_idempotency_key')
  })

  it('returns 413 payload_too_large when messages exceed the content byte cap', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({
        ...validPromptBody,
        messages: [{ role: 'user', content: 'x'.repeat(128 * 1024 + 1) }],
      })
    expect(res.status).toBe(413)
    expect(res.body.error).toBe('payload_too_large')
  })

  it('returns 400 attachments_not_supported in v1', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ ...validPromptBody, attachments: [{ name: 'file.pdf' }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('attachments_not_supported')
  })

  it('maps scope_denied to 403 with the structured code', async () => {
    vi.mocked(authorizer.authorizePromptBridge).mockResolvedValue({
      ok: false,
      error: 'scope_denied',
      message: 'missing scope',
      retryable: false,
    })
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge')
      .set('Authorization', `Bearer ${issueSdkToken([])}`)
      .send(validPromptBody)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('scope_denied')
  })

  it('maps quota_exceeded to 429', async () => {
    vi.mocked(authorizer.authorizePromptBridge).mockResolvedValue({
      ok: false,
      error: 'quota_exceeded',
      message: 'limit hit',
      retryable: false,
    })
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send(validPromptBody)
    expect(res.status).toBe(429)
    expect(res.body).toMatchObject({ error: 'quota_exceeded', retryable: false })
  })

  it('returns 201 with the invocation envelope on success', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send(validPromptBody)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ invocationId: 'inv-1', replay: false, model: 'glm-4.7' })
    expect(res.body).toMatchObject({
      selectedTarget: { targetRef: 'primary-zai', credentialSlot: 'zai-api-key' },
    })
    expect(JSON.stringify(res.body)).not.toContain('credentialTicket')
  })

  it('forwards an exact provider/model selector without accepting a raw credential', async () => {
    await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ ...validPromptBody, provider: 'openai', model: 'gpt-5.4' })
      .expect(201)
    expect(authorizer.authorizePromptBridge).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', model: 'gpt-5.4', targetRef: undefined })
    )
    expect(authorizer.authorizePromptBridge).not.toHaveBeenCalledWith(
      expect.objectContaining({ credentialSlot: expect.anything() })
    )
  })

  it('includes caller metadata in the canonical payload used for idempotency', async () => {
    await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ ...validPromptBody, metadata: { traceId: 'trace-1', source: 'sandbox-ui' } })

    expect(authorizer.authorizePromptBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          metadata: { traceId: 'trace-1', source: 'sandbox-ui' },
        }),
      })
    )
  })

  it('returns 200 on idempotent replay', async () => {
    vi.mocked(authorizer.authorizePromptBridge).mockResolvedValue({
      ok: true,
      value: {
        invocationId: 'inv-1',
        replay: true,
        status: 'complete',
        model: 'glm-4.7',
        modelPolicy: null,
        selectedTarget: {
          targetRef: 'primary-zai',
          provider: 'zai',
          model: 'glm-4.7',
          credentialSlot: 'zai-api-key',
        },
        authorizedTargets: [
          {
            targetRef: 'primary-zai',
            provider: 'zai',
            model: 'glm-4.7',
            credentialSlot: 'zai-api-key',
          },
        ],
        policyRevision: 1,
        policyHash: 'policy-hash',
        maxOutputTokens: null,
      },
    })
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send(validPromptBody)
    expect(res.status).toBe(200)
    expect(res.body.replay).toBe(true)
  })
})

describe('POST /mcp-host/plugin-workload-sdk/prompt-bridge/credential-ticket', () => {
  const body = {
    recipeNamespace: NS,
    recipeName: RECIPE,
    invocationId: 'inv-1',
    targetRef: 'openai-fallback',
    attemptGeneration: 1,
  }

  it('requires the runtime JWT and recipe binding', async () => {
    await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge/credential-ticket')
      .send(body)
      .expect(401)
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge/credential-ticket')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ ...body, recipeName: 'other-recipe' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('recipe_binding_mismatch')
    expect(authorizer.reissuePromptBridgeCredentialTicket).not.toHaveBeenCalled()
  })

  it('forwards only the bound invocation and target, never a caller or credential slot', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/prompt-bridge/credential-ticket')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ ...body, callerRef: 'attacker', credentialSlot: 'other-provider-key' })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({
      invocationId: 'inv-1',
      targetRef: 'openai-fallback',
      credentialTicket: 'signed-fresh-ticket',
      attemptGeneration: 1,
      providerAttemptId: '33333333-3333-4333-8333-333333333333',
      providerAttemptIndex: 1,
      policyRevision: 1,
      policyHash: 'policy-hash',
      expiresInSeconds: 60,
    })
    expect(authorizer.reissuePromptBridgeCredentialTicket).toHaveBeenCalledWith({
      claims: expect.objectContaining({ recipeNamespace: NS, recipeName: RECIPE }),
      invocationId: 'inv-1',
      targetRef: 'openai-fallback',
      attemptGeneration: 1,
    })
  })
})

describe('POST /mcp-host/plugin-workload-sdk/client-notification', () => {
  it('returns 400 when both target and userRef are present', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ ...validNotificationBody, userRef: 'user-1' })
    expect(res.status).toBe(400)
  })

  it('rejects an email-like targetRef as a raw channel address', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ ...validNotificationBody, target: { targetRef: 'someone@example.com' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('opaque reference')
  })

  it('rejects a phone-like userRef as a raw channel address', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({
        ...validNotificationBody,
        target: undefined,
        userRef: '+34 600 123 456',
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('opaque reference')
  })

  it('returns 413 when the notification title exceeds the byte cap', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({
        ...validNotificationBody,
        notification: { title: 'x'.repeat(257), body: 'ok' },
      })
    expect(res.status).toBe(413)
    expect(res.body.error).toBe('payload_too_large')
  })

  it('returns 400 when actionRef is present but has non-string type/id', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({
        ...validNotificationBody,
        notification: {
          title: 'Follow up',
          body: 'Lead is due',
          actionRef: { type: 42, id: null },
        },
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('string type and id')
  })

  it('accepts an absent actionRef as a valid no-op', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({
        ...validNotificationBody,
        notification: { title: 'Follow up', body: 'Lead is due' },
      })
    expect(res.status).toBe(201)
  })

  it('maps event_type_not_allowed to 403', async () => {
    vi.mocked(authorizer.authorizeClientNotification).mockResolvedValue({
      ok: false,
      error: 'event_type_not_allowed',
      message: 'not allowed',
      retryable: false,
    })
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send(validNotificationBody)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('event_type_not_allowed')
  })

  it('returns 201 with the notification envelope on success and enqueues delivery', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send(validNotificationBody)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      notificationId: 'not-1',
      status: 'accepted',
      eventType: 'lead.followup.due',
    })
    expect(notificationEmitter.enqueuePluginWorkloadSdkNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        notificationId: 'not-1',
        recipeNamespace: NS,
        recipeName: RECIPE,
        eventType: 'lead.followup.due',
        targetRef: 'team.sales',
        title: 'Follow up',
      })
    )
  })

  it('still enqueues delivery on idempotent replay (dedupe_key is idempotent)', async () => {
    vi.mocked(authorizer.authorizeClientNotification).mockResolvedValue({
      ok: true,
      value: { notificationId: 'not-1', replay: true, status: 'accepted' },
    })
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send(validNotificationBody)
    expect(res.status).toBe(200)
    expect(notificationEmitter.enqueuePluginWorkloadSdkNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ notificationId: 'not-1' })
    )
  })

  it('still accepts the intent when delivery enqueue fails (best-effort)', async () => {
    vi.mocked(notificationEmitter.enqueuePluginWorkloadSdkNotification).mockRejectedValueOnce(
      new Error('queue down')
    )
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send(validNotificationBody)
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('accepted')
  })
})

describe('POST /mcp-host/plugin-workload-sdk/client-notification/recipients', () => {
  const recipientsBody = { recipeNamespace: NS, recipeName: RECIPE, callerRef: 'api' }

  it('returns 401 without a token', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification/recipients')
      .send(recipientsBody)
    expect(res.status).toBe(401)
  })

  it('returns 400 recipe_binding_mismatch when body differs from claims', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification/recipients')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ ...recipientsBody, recipeName: 'other-recipe' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('recipe_binding_mismatch')
    expect(authorizer.authorizeListRecipients).not.toHaveBeenCalled()
  })

  it('returns 400 when callerRef is missing', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification/recipients')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ recipeNamespace: NS, recipeName: RECIPE })
    expect(res.status).toBe(400)
    expect(authorizer.authorizeListRecipients).not.toHaveBeenCalled()
  })

  it('maps caller_not_allowed to 403 without resolving names', async () => {
    vi.mocked(authorizer.authorizeListRecipients).mockResolvedValue({
      ok: false,
      error: 'caller_not_allowed',
      message: 'caller denied',
      retryable: false,
    })
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification/recipients')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send(recipientsBody)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('caller_not_allowed')
    expect(sdkDb.resolveRecipientProfiles).not.toHaveBeenCalled()
  })

  it('returns 200 with the resolved recipient list on success', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/client-notification/recipients')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send(recipientsBody)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      recipients: [
        { userRef: '11111111-1111-4111-8111-111111111111', displayName: 'Ada Lovelace' },
      ],
    })
    expect(sdkDb.resolveRecipientProfiles).toHaveBeenCalledWith([
      '11111111-1111-4111-8111-111111111111',
    ])
  })
})

describe('POST /mcp-host/plugin-workload-sdk/invocations/:id/status', () => {
  const invocation = {
    id: 'inv-1',
    recipeNamespace: NS,
    recipeName: RECIPE,
  } as Awaited<ReturnType<typeof sdkDb.getInvocationById>>

  it('rejects an unknown status value', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/invocations/inv-1/status')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ recipeNamespace: NS, recipeName: RECIPE, status: 'accepted' })
    expect(res.status).toBe(400)
  })

  it('returns 404 for a missing invocation', async () => {
    vi.mocked(sdkDb.getInvocationById).mockResolvedValue(null)
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/invocations/missing/status')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ recipeNamespace: NS, recipeName: RECIPE, status: 'complete', attemptGeneration: 1 })
    expect(res.status).toBe(404)
  })

  it('returns 403 binding_mismatch for a cross-recipe invocation', async () => {
    vi.mocked(sdkDb.getInvocationById).mockResolvedValue({
      ...invocation!,
      recipeName: 'other-recipe',
    })
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/invocations/inv-1/status')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ recipeNamespace: NS, recipeName: RECIPE, status: 'complete', attemptGeneration: 1 })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('binding_mismatch')
    expect(auditor.markInvocationStatus).not.toHaveBeenCalled()
  })

  it('returns 409 when the status update loses the invocation CAS race', async () => {
    vi.mocked(sdkDb.getInvocationById).mockResolvedValue(invocation)
    vi.mocked(auditor.markInvocationStatus).mockResolvedValue(false)
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/invocations/inv-1/status')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ recipeNamespace: NS, recipeName: RECIPE, status: 'complete', attemptGeneration: 1 })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'stale_attempt', retryable: false })
  })

  it('marks the invocation status on a valid report', async () => {
    vi.mocked(sdkDb.getInvocationById).mockResolvedValue(invocation)
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/invocations/inv-1/status')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({
        recipeNamespace: NS,
        recipeName: RECIPE,
        status: 'provider_unavailable',
        attemptGeneration: 1,
      })
    expect(res.status).toBe(200)
    expect(auditor.markInvocationStatus).toHaveBeenCalledWith('inv-1', 'provider_unavailable', {
      recipeNamespace: NS,
      recipeName: RECIPE,
      expectedCurrentStatus: 'in_progress',
      expectedAttemptGeneration: 1,
    })
  })
})

describe('GET /mcp-host/plugin-workload-sdk/invocations/:recipeRef', () => {
  it('returns 403 binding_mismatch for a recipeRef outside the JWT binding', async () => {
    const res = await request(buildApp())
      .get('/mcp-host/plugin-workload-sdk/invocations/other-recipe')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('binding_mismatch')
    expect(sdkDb.listInvocations).not.toHaveBeenCalled()
  })

  it('returns 403 for a qualified recipeRef with the wrong namespace', async () => {
    const res = await request(buildApp())
      .get(`/mcp-host/plugin-workload-sdk/invocations/${encodeURIComponent(`other-ns/${RECIPE}`)}`)
      .set('Authorization', `Bearer ${issueSdkToken()}`)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('binding_mismatch')
    expect(sdkDb.listInvocations).not.toHaveBeenCalled()
  })

  it('accepts the fully-qualified namespace/name recipeRef', async () => {
    vi.mocked(sdkDb.listInvocations).mockResolvedValue([])
    const res = await request(buildApp())
      .get(`/mcp-host/plugin-workload-sdk/invocations/${encodeURIComponent(`${NS}/${RECIPE}`)}`)
      .set('Authorization', `Bearer ${issueSdkToken()}`)
    expect(res.status).toBe(200)
    expect(sdkDb.listInvocations).toHaveBeenCalledWith({
      recipeNamespace: NS,
      recipeName: RECIPE,
      limit: 100,
    })
  })

  it('returns the recipe-scoped invocation list', async () => {
    vi.mocked(sdkDb.listInvocations).mockResolvedValue([])
    const res = await request(buildApp())
      .get(`/mcp-host/plugin-workload-sdk/invocations/${RECIPE}`)
      .set('Authorization', `Bearer ${issueSdkToken()}`)
    expect(res.status).toBe(200)
    expect(res.body.items).toEqual([])
    expect(sdkDb.listInvocations).toHaveBeenCalledWith({
      recipeNamespace: NS,
      recipeName: RECIPE,
      limit: 100,
    })
  })
})

describe('POST /mcp-host/plugin-workload-sdk/credential-ticket/introspect', () => {
  it('fails closed for an invalid ticket and never returns credential metadata', async () => {
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/credential-ticket/introspect')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({
        credentialTicket: 'not-a-ticket',
        invocationId: 'inv-1',
        targetRef: 'primary-zai',
        attemptGeneration: 1,
        providerAttemptId: '33333333-3333-4333-8333-333333333333',
        providerAttemptIndex: 1,
      })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'provider_policy_denied', retryable: false })
    expect(JSON.stringify(res.body)).not.toContain('credentialSlot')
  })

  it('consumes a valid jti exactly once after all policy and invocation checks', async () => {
    const target = {
      targetRef: 'primary-zai',
      provider: 'zai',
      model: 'glm-4.7',
      credentialSlot: 'zai-api-key',
    }
    const policyHash = sdkDb.hashPromptTargetPolicy({
      policyRevision: 1,
      defaultTargetRef: 'primary-zai',
      promptTargets: [target],
    })
    const ticket = issuePluginWorkloadSdkCredentialTicket({
      recipeNamespace: NS,
      recipeName: RECIPE,
      invocationId: 'inv-1',
      attemptGeneration: 1,
      providerAttemptId: '33333333-3333-4333-8333-333333333333',
      providerAttemptIndex: 1,
      target,
      policyRevision: 1,
      policyHash,
    })
    vi.mocked(sdkDb.getInvocationById).mockResolvedValue({
      id: 'inv-1',
      recipeNamespace: NS,
      recipeName: RECIPE,
      callerRef: 'api',
      correlationId: null,
      method: 'promptBridge',
      detail: 'glm-4.7',
      purpose: 'summarization',
      idempotencyKeyHash: 'hash',
      payloadHash: 'payload-hash',
      status: 'in_progress',
      quotaConsumed: true,
      authorizationDecision: 'authorized',
      contractVersion: 2,
      promptAuthorization: {
        policyRevision: 1,
        policyHash,
        authorizedTargetRefs: ['primary-zai'],
      },
      attemptGeneration: 1,
      leaseExpiresAt: '2026-08-02T00:01:00.000Z',
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      completedAt: null,
    })
    vi.mocked(sdkDb.findGrant).mockResolvedValue({
      id: 'grant-1',
      recipeNamespace: NS,
      recipeName: RECIPE,
      capabilityFamily: 'promptBridge',
      provider: 'zai',
      allowedModels: ['glm-4.7'],
      allowedEventTypes: [],
      allowedTargetRefs: [],
      allowedUserRefs: [],
      allowedCallers: ['api'],
      quotaLimits: {},
      modelPolicies: {},
      promptTargets: [target],
      defaultTargetRef: 'primary-zai',
      policyState: 'active',
      policyRevision: 1,
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    })

    vi.mocked(sdkDb.getPluginWorkloadSdkAttemptReceipt).mockResolvedValue({
      invocationId: 'inv-1',
      recipeNamespace: NS,
      recipeName: RECIPE,
      attemptGeneration: 1,
      method: 'promptBridge',
      targetRefs: ['primary-zai'],
      policyRevision: 1,
      policyHash,
      status: 'in_progress',
      startedAt: '2026-08-02T00:00:00.000Z',
      leaseExpiresAt: '2026-08-02T00:01:00.000Z',
      completedAt: null,
    })
    vi.mocked(sdkDb.getPluginWorkloadSdkProviderAttempt).mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      invocationId: 'inv-1',
      recipeNamespace: NS,
      recipeName: RECIPE,
      attemptGeneration: 1,
      attemptIndex: 1,
      targetRef: 'primary-zai',
      provider: 'zai',
      model: 'glm-4.7',
      credentialSlot: 'zai-api-key',
      status: 'in_progress',
      credentialJti: null,
      startedAt: '2026-08-02T00:00:00.000Z',
      leaseExpiresAt: '2026-08-02T00:01:00.000Z',
      completedAt: null,
      usageRequestId: null,
    })

    const body = {
      credentialTicket: ticket,
      invocationId: 'inv-1',
      targetRef: 'primary-zai',
      attemptGeneration: 1,
      providerAttemptId: '33333333-3333-4333-8333-333333333333',
      providerAttemptIndex: 1,
      redeem: true,
    }
    await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/credential-ticket/introspect')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send(body)
      .expect(200)
    expect(sdkDb.redeemPluginWorkloadSdkCredentialTicketJti).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: 'inv-1',
        targetRef: 'primary-zai',
        jti: expect.any(String),
      })
    )

    vi.mocked(sdkDb.redeemPluginWorkloadSdkCredentialTicketJti).mockResolvedValue(false)
    const replay = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/credential-ticket/introspect')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send(body)
    expect(replay.status).toBe(403)
    expect(replay.body).toEqual({ error: 'provider_policy_denied', retryable: false })
  })

  it('rate-limits credential-ticket introspection before expensive ticket work', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ count: 121 }], rowCount: 1 } as never)
    const res = await request(buildApp())
      .post('/mcp-host/plugin-workload-sdk/credential-ticket/introspect')
      .set('Authorization', `Bearer ${issueSdkToken()}`)
      .send({ credentialTicket: 'not-a-ticket', invocationId: 'inv-1', targetRef: 'primary-zai' })
    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBeTruthy()
    expect(authorizer.authorizePromptBridge).not.toHaveBeenCalled()
  })
})
