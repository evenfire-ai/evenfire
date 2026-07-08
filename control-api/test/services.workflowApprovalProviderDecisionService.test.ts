import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as userApprovalRequestService from '../src/services/userApprovalRequestService.js'
import * as mediumIdentityService from '../src/services/workflowApprovalMediumOperationalIdentityService.js'
import { recordProviderApprovalDecision } from '../src/services/workflowApprovalProviderDecisionService.js'
import * as telegramGateService from '../src/services/workflowApprovalTelegramChannelGateService.js'
import type { WorkflowRunRow } from '../src/services/workflowRunService.js'
import type { McpHostControlClaims } from '../src/utils/auth/mcpHostJwtToken.js'

const dbMock = vi.hoisted(() => ({
  query: vi.fn(),
}))

vi.mock('../src/db.js', () => ({
  pool: {
    query: dbMock.query,
  },
  withTransaction: vi.fn(
    async (work: (db: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) =>
      work({ query: dbMock.query })
  ),
}))

vi.mock('../src/services/userApprovalRequestService.js', () => ({
  ApprovalConsumeError: class ApprovalConsumeError extends Error {
    code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  },
  ApprovalTriggerRunIdempotencyConflictError: class ApprovalTriggerRunIdempotencyConflictError extends Error {},
  parseWorkflowTriggerIntent: vi.fn((payload: unknown) => {
    const record =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const metadata =
      record.metadata && typeof record.metadata === 'object'
        ? (record.metadata as Record<string, unknown>)
        : {}
    const workflowTrigger =
      metadata.workflowTrigger && typeof metadata.workflowTrigger === 'object'
        ? (metadata.workflowTrigger as Record<string, unknown>)
        : null
    if (!workflowTrigger) return null
    const namespace =
      typeof workflowTrigger.namespace === 'string' ? workflowTrigger.namespace.trim() : ''
    const name = typeof workflowTrigger.name === 'string' ? workflowTrigger.name.trim() : ''
    const caller = typeof workflowTrigger.caller === 'string' ? workflowTrigger.caller.trim() : ''
    const requesterUserId =
      typeof workflowTrigger.requesterUserId === 'string'
        ? workflowTrigger.requesterUserId.trim()
        : ''
    if (!namespace || !name || !caller) return null
    return { namespace, name, caller, ...(requesterUserId ? { requesterUserId } : {}) }
  }),
  recordDecision: vi.fn(),
}))

vi.mock('../src/services/workflowApprovalMediumOperationalIdentityService.js', () => ({
  findVerifiedOperationalMediumAccount: vi.fn(),
  normalizeTelegramProviderChannelType: vi.fn(value => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (
      normalized === 'private' ||
      normalized === 'group' ||
      normalized === 'supergroup' ||
      normalized === 'channel'
    ) {
      return normalized
    }
    return null
  }),
}))

vi.mock('../src/services/workflowApprovalTelegramChannelGateService.js', () => ({
  verifyTelegramOperationalChannelBinding: vi.fn().mockResolvedValue({ ok: true }),
}))

const APPROVAL_ID = '00000000-0000-0000-0000-000000000111'
const CALLER = 'sandbox-recipes/source-recipe'
const TELEGRAM_PROVIDER_TARGET = {
  hostRef: 'agent-a',
  communicationChannelNamespace: 'channels',
  communicationChannelName: 'agent-a-telegram',
}

function caller(overrides: Partial<McpHostControlClaims> = {}): McpHostControlClaims {
  return {
    sub: CALLER,
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'source-recipe',
    hostRefs: [CALLER],
    typ: 'service',
    scopes: ['workflow:approval:decide'],
    iss: 'test',
    aud: 'mcp-host',
    jti: 'jti-1',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  }
}

function pendingUserApprovalRow(overrides: Record<string, unknown> = {}) {
  return {
    status: 'pending',
    isExpired: false,
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'source-recipe',
    targetUserId: 'user-1',
    targetTeamId: null,
    payload: null,
    triggerNamespace: 'sandbox-recipes',
    triggerName: 'target-recipe',
    triggerCaller: CALLER,
    userTriggerAllowed: true,
    teamAllowed: false,
    teamMemberActive: false,
    teamTriggerAllowed: false,
    ...overrides,
  }
}

function workflowRunRow(): WorkflowRunRow {
  return {
    run_id: 'run-1',
    recipe_namespace: 'sandbox-recipes',
    recipe_name: 'target-recipe',
    phase: 'Pending',
    actor_type: 'user',
    team_id: null,
    usage_team_id: null,
    actor_id: 'user-1',
    idempotency_key: 'approval-request:00000000-0000-0000-0000-000000000111',
    trigger_source: 'approval',
    inputs: null,
    intermediate_parameters: null,
    output_overrides: null,
    child_recipe_name: null,
    child_recipe_namespace: null,
    owner_instance_id: null,
    max_duration_seconds: null,
    ttl_seconds_after_finished: null,
    approval_request_id: APPROVAL_ID,
    idempotency_payload_hash: 'hash-1',
    started_at: null,
    completed_at: null,
    last_reconciled_at: null,
    created_at: '2026-05-27T00:00:00.000Z',
    updated_at: '2026-05-27T00:00:00.000Z',
  }
}

describe('workflowApprovalProviderDecisionService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbMock.query.mockReset()
  })

  it('dedupes provider events before identity lookup or approval consumption', async () => {
    dbMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
      rows: [{ approvalRequestId: APPROVAL_ID, decision: 'approve', result: 'decided' }],
      rowCount: 1,
    })

    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'tg-chat-1',
        providerChannelType: 'group',
        providerTarget: TELEGRAM_PROVIDER_TARGET,
      },
      providerEventId: 'telegram:tg-chat-1:42',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({ ok: true, duplicate: true })
    expect(mediumIdentityService.findVerifiedOperationalMediumAccount).not.toHaveBeenCalled()
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('rejects provider event replay when the approval or decision changes', async () => {
    dbMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
      rows: [{ approvalRequestId: APPROVAL_ID, decision: 'approve', result: 'decided' }],
      rowCount: 1,
    })

    const result = await recordProviderApprovalDecision({
      approvalRequestId: '00000000-0000-0000-0000-000000000222',
      mediumIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'tg-chat-1',
        providerChannelType: 'group',
        providerTarget: TELEGRAM_PROVIDER_TARGET,
      },
      providerEventId: 'telegram:tg-chat-1:42',
      decision: 'deny',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'provider_event_replay_mismatch',
    })
    expect(mediumIdentityService.findVerifiedOperationalMediumAccount).not.toHaveBeenCalled()
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('does not report a previously failed provider event as a successful duplicate', async () => {
    dbMock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
      rows: [{ approvalRequestId: APPROVAL_ID, decision: 'approve', result: 'unverified_medium' }],
      rowCount: 1,
    })

    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'tg-chat-1',
        providerChannelType: 'group',
        providerTarget: TELEGRAM_PROVIDER_TARGET,
      },
      providerEventId: 'telegram:tg-chat-1:42',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'provider_event_previous_failure',
    })
    expect(mediumIdentityService.findVerifiedOperationalMediumAccount).not.toHaveBeenCalled()
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('requires Slack workspace identity before writing provider event state', async () => {
    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: { medium: 'slack', providerUserId: 'U123' },
      providerEventId: 'slack:T123:C123:1700000001.000001',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({ ok: false, status: 400, error: 'slack_workspace_id_required' })
    expect(dbMock.query).not.toHaveBeenCalled()
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('requires stable provider channel identity before writing provider event state', async () => {
    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: { medium: 'telegram', providerUserId: '123456' },
      providerEventId: 'telegram:tg-chat-1:42',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({ ok: false, status: 400, error: 'provider_channel_id_required' })
    expect(dbMock.query).not.toHaveBeenCalled()
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('requires Slack provider event ids to include the verified workspace and channel binding', async () => {
    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'C123',
      },
      providerEventId: 'slack:unknown:C123:1700000001.000001',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'slack_provider_event_binding_mismatch',
    })
    expect(dbMock.query).not.toHaveBeenCalled()
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('requires Telegram provider event ids to include the verified channel binding', async () => {
    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'tg-chat-1',
        providerChannelType: 'group',
        providerTarget: TELEGRAM_PROVIDER_TARGET,
      },
      providerEventId: 'telegram:other-chat:42',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: 'telegram_provider_event_binding_mismatch',
    })
    expect(dbMock.query).not.toHaveBeenCalled()
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('does not accept future media on the current Telegram and Slack bridge', async () => {
    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: { medium: 'discord', providerUserId: 'D123', providerChannelId: 'C123' },
      providerEventId: 'discord:guild:channel:42',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({ ok: false, status: 400, error: 'unsupported_provider_medium' })
    expect(dbMock.query).not.toHaveBeenCalled()
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('marks unverified provider identity and does not consume the approval', async () => {
    dbMock.query
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.mocked(mediumIdentityService.findVerifiedOperationalMediumAccount).mockResolvedValueOnce(
      null
    )

    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'tg-chat-1',
        providerChannelType: 'group',
        providerTarget: TELEGRAM_PROVIDER_TARGET,
      },
      providerEventId: 'telegram:tg-chat-1:43',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({ ok: false, status: 403, error: 'medium_identity_not_verified' })
    expect(dbMock.query).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE workflow_approval_provider_events'),
      ['telegram', 'telegram:tg-chat-1:43', 'unverified_medium']
    )
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('rejects verified Slack users from the wrong workspace before approval consumption', async () => {
    dbMock.query
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.mocked(mediumIdentityService.findVerifiedOperationalMediumAccount).mockResolvedValueOnce(
      null
    )

    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T999',
        providerChannelId: 'C123',
      },
      providerEventId: 'slack:T999:C123:1700000001.000002',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({ ok: false, status: 403, error: 'medium_identity_not_verified' })
    expect(mediumIdentityService.findVerifiedOperationalMediumAccount).toHaveBeenCalledWith(
      {
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T999',
        providerChannelId: 'C123',
        // Figure D: Slack approval decisions now bind through providerTarget.
        // No target here means the operational lookup must fail closed.
        communicationChannelRef: null,
        providerTarget: undefined,
      },
      expect.any(Object)
    )
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('consumes a verified user approval through recordDecision and returns the exact created run', async () => {
    dbMock.query
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [pendingUserApprovalRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.mocked(mediumIdentityService.findVerifiedOperationalMediumAccount).mockResolvedValueOnce({
      id: 'account-1',
      userId: 'user-1',
      medium: 'telegram',
      providerUserId: '123456',
      providerWorkspaceId: null,
      providerChannelId: 'tg-chat-1',
    })
    vi.mocked(userApprovalRequestService.recordDecision).mockResolvedValueOnce({
      ok: true,
      workflowRun: { row: workflowRunRow(), created: true },
    })

    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'tg-chat-1',
        providerChannelType: 'group',
        providerTarget: TELEGRAM_PROVIDER_TARGET,
      },
      providerEventId: 'telegram:tg-chat-1:42',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({
      ok: true,
      duplicate: false,
      run: {
        id: 'run-1',
        source: 'live',
        phase: 'Pending',
        triggeredAt: '2026-05-27T00:00:00.000Z',
        startedAt: null,
        completedAt: null,
        message: null,
        actor: { type: 'user-session', userId: 'user-1' },
        executionRef: null,
      },
    })
    expect(userApprovalRequestService.recordDecision).toHaveBeenCalledTimes(1)
    expect(userApprovalRequestService.recordDecision).toHaveBeenCalledWith(
      APPROVAL_ID,
      'approve',
      { userId: 'user-1' },
      undefined,
      { correlationId: 'telegram:tg-chat-1:42', userAgent: 'telegram:channel-reader' },
      expect.any(Object)
    )
  })

  it('accepts a private Telegram DM decision without an mcp-host CommunicationChannel target', async () => {
    dbMock.query
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [pendingUserApprovalRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.mocked(mediumIdentityService.findVerifiedOperationalMediumAccount).mockResolvedValueOnce({
      id: 'account-1',
      userId: 'user-1',
      medium: 'telegram',
      providerUserId: '123456',
      providerWorkspaceId: null,
      providerChannelId: '123456',
    })
    vi.mocked(userApprovalRequestService.recordDecision).mockResolvedValueOnce({
      ok: true,
      workflowRun: { row: workflowRunRow(), created: true },
    })

    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: '123456',
        providerChannelType: 'private',
      },
      providerEventId: 'telegram:123456:42',
      decision: 'approve',
      caller: caller(),
    })

    expect(result.ok).toBe(true)
    expect(telegramGateService.verifyTelegramOperationalChannelBinding).not.toHaveBeenCalled()
    expect(mediumIdentityService.findVerifiedOperationalMediumAccount).toHaveBeenCalledWith(
      {
        medium: 'telegram',
        providerUserId: '123456',
        providerWorkspaceId: null,
        providerChannelId: '123456',
        providerChannelType: 'private',
        providerTarget: undefined,
        // Figure D: private DM has no channel → null ref (authz filter no-ops).
        communicationChannelRef: null,
      },
      expect.objectContaining({ query: expect.any(Function) })
    )
    expect(userApprovalRequestService.recordDecision).toHaveBeenCalledWith(
      APPROVAL_ID,
      'approve',
      { userId: 'user-1' },
      undefined,
      { correlationId: 'telegram:123456:42', userAgent: 'telegram:channel-reader' },
      expect.any(Object)
    )
  })

  it('uses the sandbox recipe binding when a runtime child hostRef carries the provider callback', async () => {
    dbMock.query
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [pendingUserApprovalRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.mocked(mediumIdentityService.findVerifiedOperationalMediumAccount).mockResolvedValueOnce({
      id: 'account-1',
      userId: 'user-1',
      medium: 'telegram',
      providerUserId: '123456',
      providerWorkspaceId: null,
      providerChannelId: '123456',
    })
    vi.mocked(userApprovalRequestService.recordDecision).mockResolvedValueOnce({
      ok: true,
      workflowRun: { row: workflowRunRow(), created: true },
    })

    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: '123456',
        providerChannelType: 'private',
      },
      providerEventId: 'telegram:123456:43',
      decision: 'approve',
      caller: caller({
        hostRefs: ['sandbox-recipes/source-recipe-1234abcd'],
        sub: 'sandbox-recipes/source-recipe',
      }),
    })

    expect(result.ok).toBe(true)
    expect(userApprovalRequestService.recordDecision).toHaveBeenCalledWith(
      APPROVAL_ID,
      'approve',
      { userId: 'user-1' },
      undefined,
      { correlationId: 'telegram:123456:43', userAgent: 'telegram:channel-reader' },
      expect.any(Object)
    )
  })

  it('uses the approval recipe binding for provider decisions on step approvals without trigger intents', async () => {
    dbMock.query
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          pendingUserApprovalRow({
            triggerNamespace: null,
            triggerName: null,
            triggerCaller: null,
          }),
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.mocked(mediumIdentityService.findVerifiedOperationalMediumAccount).mockResolvedValueOnce({
      id: 'account-1',
      userId: 'user-1',
      medium: 'telegram',
      providerUserId: '123456',
      providerWorkspaceId: null,
      providerChannelId: '123456',
    })
    vi.mocked(userApprovalRequestService.recordDecision).mockResolvedValueOnce({
      ok: true,
      workflowRun: { row: workflowRunRow(), created: true },
    })

    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: '123456',
        providerChannelType: 'private',
      },
      providerEventId: 'telegram:123456:44',
      decision: 'approve',
      caller: caller({
        hostRefs: ['sandbox-recipes/source-recipe-1234abcd'],
      }),
    })

    expect(result.ok).toBe(true)
    expect(userApprovalRequestService.recordDecision).toHaveBeenCalledWith(
      APPROVAL_ID,
      'approve',
      { userId: 'user-1' },
      undefined,
      { correlationId: 'telegram:123456:44', userAgent: 'telegram:channel-reader' },
      expect.any(Object)
    )
  })

  it('rejects provider decisions when caller binding does not match typed trigger intent', async () => {
    dbMock.query
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [pendingUserApprovalRow({ triggerCaller: 'sandbox-recipes/other-recipe' })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.mocked(mediumIdentityService.findVerifiedOperationalMediumAccount).mockResolvedValueOnce({
      id: 'account-1',
      userId: 'user-1',
      medium: 'telegram',
      providerUserId: '123456',
      providerWorkspaceId: null,
      providerChannelId: 'tg-chat-1',
    })

    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'tg-chat-1',
        providerChannelType: 'group',
        providerTarget: TELEGRAM_PROVIDER_TARGET,
      },
      providerEventId: 'telegram:tg-chat-1:43',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({ ok: false, status: 403, error: 'approval_binding_mismatch' })
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('does not treat verified medium binding alone as a trigger grant', async () => {
    dbMock.query
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [pendingUserApprovalRow({ userTriggerAllowed: false })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.mocked(mediumIdentityService.findVerifiedOperationalMediumAccount).mockResolvedValueOnce({
      id: 'account-1',
      userId: 'user-1',
      medium: 'telegram',
      providerUserId: '123456',
      providerWorkspaceId: null,
      providerChannelId: 'tg-chat-1',
    })

    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'tg-chat-1',
        providerChannelType: 'group',
        providerTarget: TELEGRAM_PROVIDER_TARGET,
      },
      providerEventId: 'telegram:tg-chat-1:44',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({ ok: false, status: 403, error: 'approval_not_authorized' })
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('does not treat team membership as a trigger grant', async () => {
    dbMock.query
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          pendingUserApprovalRow({
            targetUserId: null,
            targetTeamId: 'team-1',
            userTriggerAllowed: false,
            teamAllowed: true,
            teamMemberActive: true,
            teamTriggerAllowed: false,
          }),
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.mocked(mediumIdentityService.findVerifiedOperationalMediumAccount).mockResolvedValueOnce({
      id: 'account-1',
      userId: 'user-1',
      medium: 'slack',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'C123',
    })

    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'C123',
      },
      providerEventId: 'slack:T123:C123:1700000001.000001',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({ ok: false, status: 403, error: 'approval_not_authorized' })
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('does not use a direct user grant to approve a team-targeted workflow', async () => {
    dbMock.query
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          pendingUserApprovalRow({
            targetUserId: null,
            targetTeamId: 'team-1',
            userTriggerAllowed: true,
            teamAllowed: true,
            teamMemberActive: true,
            teamTriggerAllowed: false,
          }),
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.mocked(mediumIdentityService.findVerifiedOperationalMediumAccount).mockResolvedValueOnce({
      id: 'account-1',
      userId: 'user-1',
      medium: 'telegram',
      providerUserId: '123456',
      providerWorkspaceId: null,
      providerChannelId: 'tg-chat-1',
    })

    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: 'tg-chat-1',
        providerChannelType: 'group',
        providerTarget: TELEGRAM_PROVIDER_TARGET,
      },
      providerEventId: 'telegram:tg-chat-1:45',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({ ok: false, status: 403, error: 'approval_not_authorized' })
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })

  it('does not allow another verified team member to approve a requester-bound group workflow', async () => {
    dbMock.query
      .mockResolvedValueOnce({ rows: [{ id: 'event-1' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          pendingUserApprovalRow({
            targetUserId: null,
            targetTeamId: 'team-1',
            payload: {
              message: 'Approve workflow trigger',
              metadata: {
                workflowTrigger: {
                  namespace: 'sandbox-recipes',
                  name: 'source-recipe',
                  caller: CALLER,
                  requesterUserId: 'user-1',
                },
              },
            },
            userTriggerAllowed: false,
            teamAllowed: true,
            teamMemberActive: true,
            teamTriggerAllowed: true,
          }),
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    vi.mocked(mediumIdentityService.findVerifiedOperationalMediumAccount).mockResolvedValueOnce({
      id: 'account-2',
      userId: 'user-2',
      medium: 'telegram',
      providerUserId: '654321',
      providerWorkspaceId: null,
      providerChannelId: 'tg-chat-1',
    })

    const result = await recordProviderApprovalDecision({
      approvalRequestId: APPROVAL_ID,
      mediumIdentity: {
        medium: 'telegram',
        providerUserId: '654321',
        providerChannelId: 'tg-chat-1',
        providerChannelType: 'group',
        providerTarget: TELEGRAM_PROVIDER_TARGET,
      },
      providerEventId: 'telegram:tg-chat-1:46',
      decision: 'approve',
      caller: caller(),
      gateway: {} as never,
    })

    expect(result).toEqual({ ok: false, status: 403, error: 'approval_requester_mismatch' })
    expect(userApprovalRequestService.recordDecision).not.toHaveBeenCalled()
  })
})
