import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as mediumIdentityService from '../src/services/workflowApprovalMediumOperationalIdentityService.js'
import { recordProviderApprovalDecision } from '../src/services/workflowApprovalProviderDecisionService.js'
import type { WorkflowRunRow } from '../src/services/workflowRunService.js'
import type { McpHostControlClaims } from '../src/utils/auth/mcpHostJwtToken.js'

// Unlike services.workflowApprovalProviderDecisionService.test.ts, this file runs
// the real recordDecision, so the provider path is pinned through the V2
// authority gate in userApprovalRequestService instead of a mocked decision.

const dbMock = vi.hoisted(() => ({
  query: vi.fn(),
}))

vi.mock('../src/db.js', () => ({
  pool: {
    query: dbMock.query,
    connect: vi.fn(),
  },
  withTransaction: vi.fn(
    async (work: (db: { query: ReturnType<typeof vi.fn> }) => Promise<unknown>) =>
      work({ query: dbMock.query })
  ),
}))

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/services/workflowApprovalMediumOperationalIdentityService.js', () => ({
  findVerifiedOperationalMediumAccount: vi.fn(),
  normalizeTelegramProviderChannelType: vi.fn(value => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
    return normalized === 'private' ||
      normalized === 'group' ||
      normalized === 'supergroup' ||
      normalized === 'channel'
      ? normalized
      : null
  }),
}))

vi.mock('../src/services/workflowApprovalTelegramChannelGateService.js', () => ({
  verifyTelegramOperationalChannelBinding: vi.fn().mockResolvedValue({ ok: true }),
}))

const APPROVAL_ID = '00000000-0000-0000-0000-000000000111'
const CALLER = 'sandbox-recipes/source-recipe'
const PROVIDER_EVENT_ID = 'telegram:123456:42'

function caller(): McpHostControlClaims {
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
    idempotency_key: `approval-request:${APPROVAL_ID}`,
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
    initiating_authority_binding_id: null,
    failure_reason: null,
    started_at: null,
    completed_at: null,
    last_reconciled_at: null,
    created_at: '2026-05-27T00:00:00.000Z',
    updated_at: '2026-05-27T00:00:00.000Z',
  }
}

type QueryResult = { rows: unknown[]; rowCount: number }

/**
 * Routes each statement of the provider decision transaction to the row the
 * database would return for a pending, user-targeted trigger approval. An
 * unknown statement fails the test, so a changed query path cannot pass
 * silently.
 */
function routeApprovalQueries(triggerAuthorityBindingId: string | null) {
  dbMock.query.mockImplementation(async (sql: string): Promise<QueryResult> => {
    if (sql.includes('INSERT INTO workflow_approval_provider_events')) {
      return { rows: [{ id: 'event-1' }], rowCount: 1 }
    }
    if (sql.includes('UPDATE workflow_approval_provider_events')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('AS "userTriggerAllowed"')) {
      return {
        rows: [
          {
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
          },
        ],
        rowCount: 1,
      }
    }
    if (sql.includes('trigger_authority_binding_id AS "triggerAuthorityBindingId"')) {
      return {
        rows: [
          {
            id: APPROVAL_ID,
            status: 'pending',
            isExpired: false,
            expiresAt: '2030-01-01T00:00:00.000Z',
            requestedAt: '2029-01-01T00:00:00.000Z',
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'source-recipe',
            targetUserId: 'user-1',
            targetTeamId: null,
            triggerAuthorityBindingId,
            payload: null,
          },
        ],
        rowCount: 1,
      }
    }
    if (sql.includes('decision_authority_binding_id = COALESCE')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('FROM workflow_approval_trigger_run_intents watri')) {
      return {
        rows: [
          {
            approvalRequestId: APPROVAL_ID,
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'target-recipe',
            callerKey: CALLER,
            actorType: 'user',
            actorId: 'user-1',
            teamId: null,
            usageTeamId: null,
            triggerSource: 'onDemand',
            idempotencyKey: `approval-request:${APPROVAL_ID}`,
            inputs: null,
            intermediateParameters: null,
            outputOverrides: null,
            maxDurationSeconds: null,
            ttlSecondsAfterFinished: null,
            idempotencyPayloadHash: 'hash-1',
            authorityBindingId: triggerAuthorityBindingId,
          },
        ],
        rowCount: 1,
      }
    }
    if (sql.includes('pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT * FROM workflow_runs')) {
      return { rows: [], rowCount: 0 }
    }
    // An approve decision locks the run row of its run key; no run exists yet.
    if (sql.includes('SELECT run_id FROM workflow_runs')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FOR UPDATE OF war')) {
      return {
        rows: [
          {
            status: 'approved',
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'source-recipe',
            isExpired: false,
            targetUserId: 'user-1',
            targetTeamId: null,
            payload: null,
            decidedByUserId: 'user-1',
            triggerNamespace: 'sandbox-recipes',
            triggerName: 'target-recipe',
            triggerCaller: CALLER,
            targetUserAllowed: true,
            targetTeamAllowed: false,
          },
        ],
        rowCount: 1,
      }
    }
    if (sql.includes('SELECT 1 FROM user_workflow_triggers')) {
      return { rows: [{ '?column?': 1 }], rowCount: 1 }
    }
    // The consume locks the decider's grant rows before it reads them.
    if (sql.includes('SELECT recipe_namespace, recipe_name') && sql.includes('FOR SHARE')) {
      return {
        rows: [
          { recipe_namespace: 'sandbox-recipes', recipe_name: 'source-recipe' },
          { recipe_namespace: 'sandbox-recipes', recipe_name: 'target-recipe' },
        ],
        rowCount: 2,
      }
    }
    if (sql.includes("SET status = 'consumed'")) {
      return { rows: [{ teamId: null }], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO workflow_runs')) {
      return { rows: [workflowRunRow()], rowCount: 1 }
    }
    throw new Error(`unexpected query in provider decision test: ${sql.slice(0, 120)}`)
  })
}

function statements(fragment: string): unknown[][] {
  return dbMock.query.mock.calls.filter(([sql]) => String(sql).includes(fragment))
}

async function decideFromTelegramDm() {
  vi.mocked(mediumIdentityService.findVerifiedOperationalMediumAccount).mockResolvedValueOnce({
    id: 'account-1',
    userId: 'user-1',
    medium: 'telegram',
    providerUserId: '123456',
    providerWorkspaceId: null,
    providerChannelId: '123456',
    communicationChannelRef: null,
    displayName: null,
    disabledAt: null,
  })
  return recordProviderApprovalDecision({
    approvalRequestId: APPROVAL_ID,
    mediumIdentity: {
      medium: 'telegram',
      providerUserId: '123456',
      providerChannelId: '123456',
      providerChannelType: 'private',
    },
    providerEventId: PROVIDER_EVENT_ID,
    decision: 'approve',
    caller: caller(),
  })
}

describe('provider approval decisions without V2 trigger authority (M-41 WF-22)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dbMock.query.mockReset()
  })

  it('approves an approval without a trigger authority binding as in dev and starts its run', async () => {
    routeApprovalQueries(null)

    const result = await decideFromTelegramDm()

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
        approvalRequestId: APPROVAL_ID,
      },
    })
    // Liveness witnesses: the provider event records success, and the run
    // advances through the decision, the approval consumption and the insert.
    expect(
      statements('UPDATE workflow_approval_provider_events').map(([, params]) => params)
    ).toEqual([['telegram', PROVIDER_EVENT_ID, 'decided']])
    const [decisionUpdate] = statements('decision_authority_binding_id = COALESCE')
    expect(decisionUpdate?.[1]).toEqual([
      APPROVAL_ID,
      'approved',
      expect.any(String),
      expect.any(Date),
      'user-1',
      null,
      'telegram:channel-reader',
      null,
    ])
    expect(statements("SET status = 'consumed'")).toHaveLength(1)
    const [runInsert] = statements('INSERT INTO workflow_runs')
    expect((runInsert?.[1] as unknown[] | undefined)?.at(-1)).toBeNull()
    // The decision neither needs nor writes V2 authority.
    expect(statements('workflow_authority_bindings')).toHaveLength(0)
  })

  it('still answers 403 when the approval carries a trigger authority binding', async () => {
    routeApprovalQueries('binding-1')

    const result = await decideFromTelegramDm()

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'workflow_approval_authority_required',
    })
    // Liveness witness: recordDecision locked the approval row and the provider
    // event records the authority failure.
    expect(statements('trigger_authority_binding_id AS "triggerAuthorityBindingId"')).toHaveLength(
      1
    )
    expect(
      statements('UPDATE workflow_approval_provider_events').map(([, params]) => params)
    ).toEqual([['telegram', PROVIDER_EVENT_ID, 'workflow_approval_authority_required']])
    expect(statements('decision_authority_binding_id = COALESCE')).toHaveLength(0)
    expect(statements('INSERT INTO workflow_runs')).toHaveLength(0)
  })
})
