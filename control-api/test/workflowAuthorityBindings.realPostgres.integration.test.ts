import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { CanonicalActionTarget } from '@clerum/action-context-contracts'
import { initDb, pool, withTransaction } from '../src/db.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { authorizeActionV2 } from '../src/services/access/actionAuthorizer.js'
import { prepareActionOperationTarget } from '../src/services/access/actionMessageId.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import { createUserSession, revokeUserSession } from '../src/services/auth/userSessionService.js'
import { adminDeleteTeam } from '../src/services/directory/teams.js'
import { recordDecision } from '../src/services/userApprovalRequestService.js'
import { createRun } from '../src/services/workflowRunService.js'
import { deriveApprovalConsumeAuthority } from '../src/services/workflows/workflowActionTransition.js'
import {
  type WorkflowAuthorityBinding,
  persistWorkflowAuthorityBinding,
  requireCurrentWorkflowApprovalAuthority,
  workflowAuthorityBindingFromClaims,
} from '../src/services/workflows/workflowAuthorityBindingService.js'
import { createWorkflowTriggerApprovalRequest } from '../src/services/workflows/workflowTriggerApprovalService.js'
import {
  issueUserDelegationV2,
  verifyUserDelegationV2,
} from '../src/utils/auth/userDelegationV2Token.js'

vi.mock('../src/services/notificationEmitter.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/notificationEmitter.js')>()),
  emitNotification: vi.fn().mockResolvedValue(undefined),
}))

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const describeRealPostgres = adminUrl ? describe : describe.skip
const defaultTtlSecondsAfterFinished = 2_592_000
const runtimeRoles = [
  'control_api_runtime',
  'trace_maintenance_runtime',
  'workflow_recipes_runtime',
] as const

function databaseUrl(baseUrl: string, database: string): string {
  const value = new URL(baseUrl)
  value.pathname = `/${database}`
  return value.toString()
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

describeRealPostgres('workflow authority bindings on real PostgreSQL', () => {
  const database = `control_api_workflow_authority_${randomBytes(6).toString('hex')}`
  const connectionString = databaseUrl(
    adminUrl ?? 'postgresql://postgres@127.0.0.1/postgres',
    database
  )
  const userId = randomUUID()
  let adminPool: Pool
  let databasePool: Pool
  let corePoolConnectSpy: ReturnType<typeof vi.spyOn>

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: adminUrl })
    await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    databasePool = new Pool({ connectionString })
    await initDb({ connect: () => databasePool.connect() })
    corePoolConnectSpy = vi
      .spyOn(pool, 'connect')
      .mockImplementation((() => databasePool.connect()) as typeof pool.connect)
    await databasePool.query(
      `INSERT INTO users(id, email, name) VALUES ($1, $2, 'Workflow Authority User')`,
      [userId, `${userId}@example.test`]
    )
  })

  afterAll(async () => {
    corePoolConnectSpy?.mockRestore()
    expect(databasePool?.waitingCount ?? 0).toBe(0)
    expect(databasePool?.idleCount ?? 0).toBe(databasePool?.totalCount ?? 0)
    await databasePool?.end()
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database]
      )
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
      await adminPool.query(`DROP ROLE IF EXISTS ${runtimeRoles.join(', ')}`)
      await adminPool.end()
    }
  })

  afterEach(() => {
    expect(databasePool?.waitingCount ?? 0).toBe(0)
    expect(databasePool?.idleCount ?? 0).toBe(databasePool?.totalCount ?? 0)
  })

  async function authority(input?: {
    operationId?: 'workflow.trigger' | 'workflow.read' | 'workflow.approval.decide'
    resourceType?: 'workflow_recipe' | 'workflow_approval'
    resourceLogicalId?: string
    target?: CanonicalActionTarget
    effectiveTeamId?: string
  }): Promise<WorkflowAuthorityBinding> {
    const issued = await createUserSession({
      userId,
      email: `${userId}@example.test`,
      authenticationMethods: ['password'],
    })
    const operationId = input?.operationId ?? 'workflow.trigger'
    const target =
      input?.target ?? Object.freeze({ recipeNamespace: 'sandbox-recipes', recipeName: 'demo' })
    const resource = canonicalResourceIdentity({
      environmentId: canonicalEnvironmentId(),
      type: input?.resourceType ?? 'workflow_recipe',
      logicalId: input?.resourceLogicalId ?? 'sandbox-recipes/demo',
    })
    const prepared = prepareActionOperationTarget({
      operationId,
      resource,
      operationTarget: target,
    })
    const claims = verifyUserDelegationV2(
      issueUserDelegationV2({
        principal: {
          userId,
          sid: issued.identity.sid,
          sessionVersion: issued.identity.sessionVersion,
        },
        operationIds: [operationId],
        resource,
        preparedTargets: { [operationId]: prepared },
        accessPathId: `ap1_${'a'.repeat(43)}`,
        authorizationRevision: `ar1_${'b'.repeat(43)}`,
        behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
        pathKind: input?.effectiveTeamId ? 'team' : 'direct',
        effectiveTeamId: input?.effectiveTeamId ?? null,
      })
    )
    if (!claims) throw new Error('real producer failed to verify its workflow delegation')
    return workflowAuthorityBindingFromClaims(claims)
  }

  async function liveDecisionAuthority(input: {
    approvalRequestId: string
    decision: 'approve' | 'deny'
  }): Promise<WorkflowAuthorityBinding> {
    const approval = await databasePool.query<{
      recipe_namespace: string
      recipe_name: string
    }>(
      `SELECT recipe_namespace, recipe_name
         FROM workflow_approval_requests
        WHERE id = $1`,
      [input.approvalRequestId]
    )
    const recipeNamespace = approval.rows[0]?.recipe_namespace
    const recipeName = approval.rows[0]?.recipe_name
    if (!recipeNamespace || !recipeName) throw new Error('approval recipe was not found')
    await databasePool.query(
      `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [userId, recipeNamespace, recipeName]
    )
    const session = await createUserSession({
      userId,
      email: `${userId}@example.test`,
      authenticationMethods: ['password'],
    })
    const resource = canonicalResourceIdentity({
      environmentId: canonicalEnvironmentId(),
      type: 'workflow_approval',
      logicalId: input.approvalRequestId,
    })
    const target = Object.freeze({
      approvalId: input.approvalRequestId,
      decision: input.decision,
    })
    const authorized = await authorizeActionV2({
      session: {
        contract: 'v2',
        userId,
        sid: session.identity.sid,
        jti: session.identity.jti,
        sessionVersion: session.identity.sessionVersion,
      },
      requested: { version: 2 },
      operationId: 'workflow.approval.decide',
      resource,
      operationTarget: target,
      allocateChatMessageId: false,
    })
    expect(authorized.status).toBe('allowed')
    if (authorized.status !== 'allowed') throw new Error('expected live approval authority')
    const claims = verifyUserDelegationV2(
      issueUserDelegationV2({
        principal: {
          userId,
          sid: session.identity.sid,
          sessionVersion: session.identity.sessionVersion,
        },
        operationIds: ['workflow.approval.decide'],
        resource,
        preparedTargets: {
          'workflow.approval.decide': {
            target: authorized.context.target,
            targetHash: authorized.context.targetHash,
          },
        },
        accessPathId: authorized.context.accessPathId,
        authorizationRevision: authorized.context.authorizationRevision,
        behaviorBindingHash: authorized.context.behaviorBindingHash,
        pathKind: authorized.context.pathKind,
        effectiveTeamId: authorized.context.effectiveTeamId,
      })
    )
    if (!claims) throw new Error('live approval delegation failed verification')
    return workflowAuthorityBindingFromClaims(claims)
  }

  function decisionReauthorizer(
    initial: WorkflowAuthorityBinding,
    budget: AccessExecutionBudget,
    hooks: {
      afterPhaseOne?: () => Promise<void>
      beforeFinalFence?: () => Promise<void>
    } = {}
  ) {
    let phaseOne = true
    let finalFencePending = true
    return {
      authorizeBeforeLock: async () => {
        const current = await withTransaction(transaction =>
          requireCurrentWorkflowApprovalAuthority({
            db: transaction,
            authority: initial,
            budget,
          })
        )
        if (hooks.afterPhaseOne && phaseOne) await hooks.afterPhaseOne()
        phaseOne = false
        return current
      },
      validateCurrentInTransaction: (
        db: Parameters<typeof requireCurrentWorkflowApprovalAuthority>[0]['db']
      ) =>
        requireCurrentWorkflowApprovalAuthority({
          db: hooks.beforeFinalFence
            ? {
                query: async (sql, values) => {
                  if (finalFencePending && /^SELECT sid\s+FROM external_user_sessions/s.test(sql)) {
                    finalFencePending = false
                    await hooks.beforeFinalFence?.()
                  }
                  return db.query(sql, values)
                },
              }
            : db,
          authority: initial,
          budget,
        }),
    }
  }

  async function createDecisionApproval(recipeName: string) {
    const triggerAuthority = await authority({
      resourceLogicalId: `sandbox-recipes/${recipeName}`,
      target: Object.freeze({ recipeNamespace: 'sandbox-recipes', recipeName }),
    })
    const approval = await createWorkflowTriggerApprovalRequest({
      recipeNamespace: 'sandbox-recipes',
      recipeName,
      callerKey: 'external-rest-api',
      targetUserId: userId,
      payload: { message: 'Approve the workflow trigger' },
      idempotencyKey: `approval-${randomUUID()}`,
      runIntent: {
        actorType: 'user',
        actorId: userId,
        triggerSource: 'onDemand',
        ttlSecondsAfterFinished: defaultTtlSecondsAfterFinished,
      },
      authority: triggerAuthority,
      reauthorize: async () => triggerAuthority,
    })
    expect(approval.kind).toBe('approval')
    if (approval.kind !== 'approval') throw new Error('expected approval request')
    return approval.approvalRequestId
  }

  it('persists one immutable trigger binding and links an idempotent run transactionally', async () => {
    const currentAuthority = await authority()
    const input = {
      recipe_namespace: 'sandbox-recipes',
      recipe_name: 'demo',
      actor_type: 'user' as const,
      actor_id: userId,
      idempotency_key: `authority-${randomUUID()}`,
      trigger_source: 'onDemand' as const,
      ttl_seconds_after_finished: defaultTtlSecondsAfterFinished,
      authority: currentAuthority,
    }

    const [first, second] = await Promise.all([createRun(input), createRun(input)])
    expect(new Set([first.row.run_id, second.row.run_id])).toHaveLength(1)
    expect([first.created, second.created].sort()).toEqual([false, true])
    expect(first.row.initiating_authority_binding_id).toBeTruthy()

    const persisted = await databasePool.query(
      `SELECT binding_kind, delegation_jti, operation_id, access_path_id,
              authorization_revision, source_expires_at > source_issued_at AS bounded
         FROM workflow_authority_bindings
        WHERE id = $1`,
      [first.row.initiating_authority_binding_id]
    )
    expect(persisted.rows).toEqual([
      expect.objectContaining({
        binding_kind: 'trigger',
        delegation_jti: currentAuthority.binding.delegationJti,
        operation_id: 'workflow.trigger',
        access_path_id: currentAuthority.binding.accessPathId,
        authorization_revision: currentAuthority.binding.authorizationRevision,
        bounded: true,
      }),
    ])
  })

  it('preserves legacy runs without inventing workflow authority', async () => {
    const legacy = await createRun(
      {
        recipe_namespace: 'sandbox-recipes',
        recipe_name: 'legacy-demo',
        actor_type: 'user',
        actor_id: userId,
        idempotency_key: `legacy-${randomUUID()}`,
        trigger_source: 'onDemand',
        ttl_seconds_after_finished: defaultTtlSecondsAfterFinished,
      },
      databasePool
    )
    expect(legacy.row.initiating_authority_binding_id).toBeNull()
  })

  it('persists authorized workflow reads with the closed workflow-recipe vocabulary', async () => {
    const recipeAuthority = await authority({ operationId: 'workflow.read' })
    const entityId = `sandbox-recipes/read-${randomUUID()}`

    const id = await persistWorkflowAuthorityBinding(databasePool, {
      authority: recipeAuthority,
      kind: 'workflow_read',
      entityType: 'workflow_recipe',
      entityId,
    })

    const persisted = await databasePool.query(
      `SELECT binding_kind, entity_type, entity_id, operation_id
         FROM workflow_authority_bindings
        WHERE id = $1`,
      [id]
    )
    expect(persisted.rows).toEqual([
      {
        binding_kind: 'workflow_read',
        entity_type: 'workflow_recipe',
        entity_id: entityId,
        operation_id: 'workflow.read',
      },
    ])
    await expect(
      persistWorkflowAuthorityBinding(databasePool, {
        authority: recipeAuthority,
        kind: 'workflow_read',
        entityType: 'unregistered_workflow_entity',
        entityId,
      })
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('rejects legacy/v2 approval idempotency reuse in both directions', async () => {
    const base = {
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'approval-idempotency-demo',
      callerKey: 'external-rest-api',
      targetUserId: userId,
      payload: { message: 'Approve the workflow trigger' },
      runIntent: {
        actorType: 'user' as const,
        actorId: userId,
        teamId: null,
        usageTeamId: null,
        triggerSource: 'onDemand' as const,
        ttlSecondsAfterFinished: defaultTtlSecondsAfterFinished,
      },
    }
    const currentAuthority = await authority({
      resourceLogicalId: 'sandbox-recipes/approval-idempotency-demo',
      target: {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'approval-idempotency-demo',
      },
    })

    const legacyFirstKey = `approval-legacy-first-${randomUUID()}`
    await expect(
      createWorkflowTriggerApprovalRequest({ ...base, idempotencyKey: legacyFirstKey })
    ).resolves.toMatchObject({ kind: 'approval' })
    await expect(
      createWorkflowTriggerApprovalRequest({
        ...base,
        idempotencyKey: legacyFirstKey,
        authority: currentAuthority,
      })
    ).resolves.toMatchObject({ kind: 'mismatch' })

    const v2FirstKey = `approval-v2-first-${randomUUID()}`
    await expect(
      createWorkflowTriggerApprovalRequest({
        ...base,
        idempotencyKey: v2FirstKey,
        authority: currentAuthority,
      })
    ).resolves.toMatchObject({ kind: 'approval' })
    await expect(
      createWorkflowTriggerApprovalRequest({ ...base, idempotencyKey: v2FirstKey })
    ).resolves.toMatchObject({ kind: 'mismatch' })
  })

  it('rejects legacy/v2 run idempotency reuse in both directions', async () => {
    const currentAuthority = await authority()
    const base = {
      recipe_namespace: 'sandbox-recipes',
      recipe_name: 'run-idempotency-demo',
      actor_type: 'user' as const,
      actor_id: userId,
      trigger_source: 'onDemand' as const,
      ttl_seconds_after_finished: defaultTtlSecondsAfterFinished,
    }

    const legacyFirstKey = `run-legacy-first-${randomUUID()}`
    await expect(
      createRun({ ...base, idempotency_key: legacyFirstKey }, databasePool)
    ).resolves.toMatchObject({ created: true })
    await expect(
      createRun({ ...base, idempotency_key: legacyFirstKey, authority: currentAuthority })
    ).rejects.toThrow('Idempotency-Key was reused with a different workflow trigger payload')

    const v2FirstKey = `run-v2-first-${randomUUID()}`
    await expect(
      createRun({ ...base, idempotency_key: v2FirstKey, authority: currentAuthority })
    ).resolves.toMatchObject({ created: true })
    await expect(createRun({ ...base, idempotency_key: v2FirstKey }, databasePool)).rejects.toThrow(
      'Idempotency-Key was reused with a different workflow trigger payload'
    )
  })

  it('keeps historical provenance without blocking session cleanup or empty-team deletion', async () => {
    const currentAuthority = await authority()
    await createRun({
      recipe_namespace: 'sandbox-recipes',
      recipe_name: 'lifecycle-demo',
      actor_type: 'user',
      actor_id: userId,
      idempotency_key: `lifecycle-${randomUUID()}`,
      trigger_source: 'onDemand',
      ttl_seconds_after_finished: defaultTtlSecondsAfterFinished,
      authority: currentAuthority,
    })
    await expect(
      revokeUserSession(userId, currentAuthority.binding.sid, 'workflow-binding-lifecycle')
    ).resolves.toBe(true)
    await expect(
      databasePool.query(`DELETE FROM external_user_sessions WHERE sid = $1`, [
        currentAuthority.binding.sid,
      ])
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(
      createUserSession({
        userId,
        email: `${userId}@example.test`,
        authenticationMethods: ['password'],
      })
    ).resolves.toBeTruthy()
    await expect(
      databasePool.query(`SELECT 1 FROM workflow_authority_bindings WHERE session_id = $1`, [
        currentAuthority.binding.sid,
      ])
    ).resolves.toMatchObject({ rowCount: 1 })

    const teamId = randomUUID()
    await databasePool.query(`INSERT INTO teams(id, name) VALUES ($1, 'Historical Binding Team')`, [
      teamId,
    ])
    await databasePool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES ($1, $2, 'member', 'active')`,
      [teamId, userId]
    )
    const teamAuthority = await authority({ effectiveTeamId: teamId })
    await createRun({
      recipe_namespace: 'sandbox-recipes',
      recipe_name: 'team-lifecycle-demo',
      actor_type: 'user',
      actor_id: userId,
      idempotency_key: `team-lifecycle-${randomUUID()}`,
      trigger_source: 'onDemand',
      ttl_seconds_after_finished: defaultTtlSecondsAfterFinished,
      authority: teamAuthority,
    })
    await databasePool.query(`DELETE FROM team_members WHERE team_id = $1`, [teamId])
    await expect(adminDeleteTeam(teamId)).resolves.toEqual({ ok: true, id: teamId })
  })

  it('completes a live approval decision with one shared pool connection', async () => {
    const approvalRequestId = await createDecisionApproval(`pool-one-${randomUUID()}`)
    const decisionAuthority = await liveDecisionAuthority({
      approvalRequestId,
      decision: 'deny',
    })
    const singleConnectionPool = new Pool({ connectionString, max: 1 })
    corePoolConnectSpy.mockImplementation((() =>
      singleConnectionPool.connect()) as typeof pool.connect)
    const budget = AccessExecutionBudget.create('action')
    try {
      await expect(
        recordDecision(
          approvalRequestId,
          'deny',
          { userId },
          undefined,
          undefined,
          undefined,
          decisionAuthority,
          decisionReauthorizer(decisionAuthority, budget)
        )
      ).resolves.toEqual({ ok: true })
      expect(singleConnectionPool.waitingCount).toBe(0)
      expect(singleConnectionPool.totalCount).toBe(1)
    } finally {
      budget.close()
      corePoolConnectSpy.mockImplementation((() => databasePool.connect()) as typeof pool.connect)
      await singleConnectionPool.end()
    }
  })

  it('rejects approval and authority races after phase-one authorization', async () => {
    const snapshotRaceId = await createDecisionApproval(`snapshot-race-${randomUUID()}`)
    const authorityRaceId = await createDecisionApproval(`authority-race-${randomUUID()}`)
    const snapshotAuthority = await liveDecisionAuthority({
      approvalRequestId: snapshotRaceId,
      decision: 'deny',
    })
    const snapshotBudget = AccessExecutionBudget.create('action')
    try {
      await expect(
        recordDecision(
          snapshotRaceId,
          'deny',
          { userId },
          undefined,
          undefined,
          undefined,
          snapshotAuthority,
          decisionReauthorizer(snapshotAuthority, snapshotBudget, {
            afterPhaseOne: async () => {
              await databasePool.query(
                `UPDATE workflow_approval_requests
                    SET payload = jsonb_set(payload, '{message}', '"changed"'::jsonb)
                  WHERE id = $1`,
                [snapshotRaceId]
              )
            },
          })
        )
      ).rejects.toThrow('Workflow approval authority became stale')

      const authority = await liveDecisionAuthority({
        approvalRequestId: authorityRaceId,
        decision: 'deny',
      })
      const authorityBudget = AccessExecutionBudget.create('action')
      try {
        await expect(
          recordDecision(
            authorityRaceId,
            'deny',
            { userId },
            undefined,
            undefined,
            undefined,
            authority,
            decisionReauthorizer(authority, authorityBudget, {
              beforeFinalFence: async () => {
                await databasePool.query(
                  `DELETE FROM user_workflow_triggers
                    WHERE user_id = $1 AND recipe_namespace = 'sandbox-recipes'
                      AND recipe_name = (SELECT recipe_name FROM workflow_approval_requests WHERE id = $2)`,
                  [userId, authorityRaceId]
                )
              },
            })
          )
        ).rejects.toMatchObject({ status: 409, code: 'access_path_stale' })
      } finally {
        authorityBudget.close()
      }
    } finally {
      snapshotBudget.close()
    }

    const rows = await databasePool.query<{
      id: string
      status: string
      decision_authority_binding_id: string | null
    }>(
      `SELECT id, status, decision_authority_binding_id
         FROM workflow_approval_requests
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[snapshotRaceId, authorityRaceId]]
    )
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'pending', decision_authority_binding_id: null }),
        expect.objectContaining({ status: 'pending', decision_authority_binding_id: null }),
      ])
    )
  })

  it('uses final database time when approval expiry races authorization', async () => {
    const approvalRequestId = await createDecisionApproval(`expiry-race-${randomUUID()}`)
    const decisionAuthority = await liveDecisionAuthority({
      approvalRequestId,
      decision: 'deny',
    })
    const budget = AccessExecutionBudget.create('action')
    try {
      await expect(
        recordDecision(
          approvalRequestId,
          'deny',
          { userId },
          undefined,
          undefined,
          undefined,
          decisionAuthority,
          decisionReauthorizer(decisionAuthority, budget, {
            afterPhaseOne: async () => {
              await databasePool.query(
                `UPDATE workflow_approval_requests
                    SET expires_at = clock_timestamp() - INTERVAL '1 millisecond'
                  WHERE id = $1`,
                [approvalRequestId]
              )
            },
          })
        )
      ).resolves.toEqual({ ok: false, error: 'expired' })
    } finally {
      budget.close()
    }
    await expect(
      databasePool.query(
        `SELECT status, decision_authority_binding_id
           FROM workflow_approval_requests
          WHERE id = $1`,
        [approvalRequestId]
      )
    ).resolves.toMatchObject({
      rows: [{ status: 'expired', decision_authority_binding_id: null }],
    })
  })

  it('serializes approval consumption and persists its one permitted child edge atomically', async () => {
    await databasePool.query(
      `INSERT INTO user_workflow_triggers(user_id, recipe_namespace, recipe_name)
       VALUES ($1, 'sandbox-recipes', 'approval-demo')
       ON CONFLICT DO NOTHING`,
      [userId]
    )
    const triggerAuthority = await authority({
      target: Object.freeze({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'approval-demo',
      }),
      resourceLogicalId: 'sandbox-recipes/approval-demo',
    })
    const approval = await createWorkflowTriggerApprovalRequest({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'approval-demo',
      callerKey: 'external-rest-api',
      targetUserId: userId,
      payload: { message: 'Approve the workflow trigger' },
      idempotencyKey: `approval-${randomUUID()}`,
      runIntent: {
        actorType: 'user',
        actorId: userId,
        triggerSource: 'onDemand',
        ttlSecondsAfterFinished: defaultTtlSecondsAfterFinished,
      },
      authority: triggerAuthority,
      reauthorize: async () => triggerAuthority,
    })
    expect(approval.kind).toBe('approval')
    if (approval.kind !== 'approval') throw new Error('expected approval request')

    const decisionAuthority = await liveDecisionAuthority({
      approvalRequestId: approval.approvalRequestId,
      decision: 'approve',
    })
    const budgets = Array.from({ length: 12 }, () => AccessExecutionBudget.create('action'))
    const decide = (budget: AccessExecutionBudget) =>
      recordDecision(
        approval.approvalRequestId,
        'approve',
        { userId },
        undefined,
        undefined,
        undefined,
        decisionAuthority,
        decisionReauthorizer(decisionAuthority, budget)
      )
    const results = await Promise.all(budgets.map(decide)).finally(() => {
      budgets.forEach(budget => budget.close())
    })
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok)).toHaveLength(11)
    expect(results.filter(result => !result.ok)).toEqual(
      expect.arrayContaining(
        Array.from({ length: 11 }, () =>
          expect.objectContaining({ ok: false, error: 'not_pending' })
        )
      )
    )

    const durable = await databasePool.query<{
      status: string
      run_count: string
      decision_kind: string
      consume_kind: string
      transition_id: string
      child_operation: string
      parent_operation: string
      child_expires_before_parent: boolean
      child_expires_before_approval: boolean
    }>(
      `SELECT war.status,
              COUNT(wr.run_id)::text AS run_count,
              decision.binding_kind AS decision_kind,
              consume.binding_kind AS consume_kind,
              consume.transition_id,
              consume.operation_id AS child_operation,
              decision.operation_id AS parent_operation,
              consume.source_expires_at <= decision.source_expires_at AS child_expires_before_parent,
              consume.source_expires_at <= war.expires_at AS child_expires_before_approval
         FROM workflow_approval_requests war
         JOIN workflow_authority_bindings decision
           ON decision.id = war.decision_authority_binding_id
         JOIN workflow_authority_bindings consume
           ON consume.id = war.consume_authority_binding_id
    LEFT JOIN workflow_runs wr ON wr.approval_request_id = war.id
        WHERE war.id = $1
        GROUP BY war.status, war.expires_at, decision.binding_kind, consume.binding_kind,
                 consume.transition_id, consume.operation_id, decision.operation_id,
                 consume.source_expires_at, decision.source_expires_at`,
      [approval.approvalRequestId]
    )
    expect(durable.rows).toEqual([
      {
        status: 'consumed',
        run_count: '1',
        decision_kind: 'approval_decision',
        consume_kind: 'approval_consume',
        transition_id: 'workflow.approval.decide->workflow.approval.consume',
        child_operation: 'workflow.approval.consume',
        parent_operation: 'workflow.approval.decide',
        child_expires_before_parent: true,
        child_expires_before_approval: true,
      },
    ])
  })

  it('expires an approval racing decision without persisting authority or creating a run', async () => {
    const triggerAuthority = await authority({
      target: Object.freeze({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'expired-approval-demo',
      }),
      resourceLogicalId: 'sandbox-recipes/expired-approval-demo',
    })
    const approval = await createWorkflowTriggerApprovalRequest({
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'expired-approval-demo',
      callerKey: 'external-rest-api',
      targetUserId: userId,
      payload: { message: 'Expired approval' },
      idempotencyKey: `expired-approval-${randomUUID()}`,
      runIntent: {
        actorType: 'user',
        actorId: userId,
        triggerSource: 'onDemand',
        ttlSecondsAfterFinished: defaultTtlSecondsAfterFinished,
      },
      authority: triggerAuthority,
      reauthorize: async () => triggerAuthority,
    })
    expect(approval.kind).toBe('approval')
    if (approval.kind !== 'approval') throw new Error('expected approval request')
    await databasePool.query(
      `UPDATE workflow_approval_requests SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [approval.approvalRequestId]
    )
    const decisionAuthority = await authority({
      operationId: 'workflow.approval.decide',
      resourceType: 'workflow_approval',
      resourceLogicalId: approval.approvalRequestId,
      target: Object.freeze({ approvalId: approval.approvalRequestId, decision: 'approve' }),
    })

    await expect(
      recordDecision(
        approval.approvalRequestId,
        'approve',
        { userId },
        undefined,
        undefined,
        undefined,
        decisionAuthority,
        async () => decisionAuthority
      )
    ).resolves.toEqual({ ok: false, error: 'expired' })
    const denied = await databasePool.query<{ status: string; bindings: string; runs: string }>(
      `SELECT war.status,
              COUNT(DISTINCT bindings.id)::text AS bindings,
              COUNT(DISTINCT runs.run_id)::text AS runs
         FROM workflow_approval_requests war
    LEFT JOIN workflow_authority_bindings bindings
           ON bindings.entity_type = 'workflow_approval' AND bindings.entity_id = war.id::text
    LEFT JOIN workflow_runs runs ON runs.approval_request_id = war.id
        WHERE war.id = $1
        GROUP BY war.status`,
      [approval.approvalRequestId]
    )
    expect(denied.rows).toEqual([{ status: 'expired', bindings: '1', runs: '0' }])
  })

  it('enforces the single child-transition and parent-link constraints', async () => {
    const constraints = await databasePool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'workflow_authority_bindings'::regclass`
    )
    const definitions = constraints.rows.map(row => row.definition).join('\n')
    expect(definitions).toContain('workflow.approval.decide->workflow.approval.consume')
    expect(definitions).toContain('parent_binding_id IS NULL')
    expect(definitions).toContain('transition_id IS NULL')

    const triggerAuthority = await authority()
    const wrongParentId = await persistWorkflowAuthorityBinding(databasePool, {
      authority: triggerAuthority,
      kind: 'trigger',
      entityType: 'workflow_trigger',
      entityId: `constraint-parent-${randomUUID()}`,
    })
    const approvalId = randomUUID()
    const child = deriveApprovalConsumeAuthority({
      parent: await authority({
        operationId: 'workflow.approval.decide',
        resourceType: 'workflow_approval',
        resourceLogicalId: approvalId,
        target: { approvalId, decision: 'approve' },
      }),
      approvalId,
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'demo',
      approvalExpiresAt: new Date(Date.now() + 60_000),
    })
    await expect(
      persistWorkflowAuthorityBinding(databasePool, {
        authority: child,
        kind: 'approval_consume',
        entityType: 'workflow_approval',
        entityId: approvalId,
        parentBindingId: wrongParentId,
        transitionId: 'workflow.approval.decide->workflow.approval.consume',
      })
    ).rejects.toMatchObject({ code: '23514' })
  })
})
