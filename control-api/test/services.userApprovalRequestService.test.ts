import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, withTransaction } from '../src/db.js'
import { enqueueApprovalRequestedNotification } from '../src/services/notificationEmitter.js'
import {
  InvalidWorkflowTriggerIntentError,
  allowlistCheck,
  assertApprovalTriggerBinding,
  cancelRequest,
  consumeApprovalForTrigger,
  createApprovalRequest,
  expirePendingRequests,
  getApprovalRecipeBinding,
  getStatus,
  parseWorkflowTriggerIntent,
  recordDecision,
  resolveWorkflowTriggerGrant,
  triggerGrantCheck,
} from '../src/services/userApprovalRequestService.js'

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

vi.mock('../src/services/notificationEmitter.js', () => ({
  emitNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalRequestedNotification: vi.fn().mockResolvedValue(undefined),
  enqueueApprovalUpdatedNotification: vi.fn().mockResolvedValue(undefined),
}))

const mockedQuery = vi.mocked(pool.query) as ReturnType<typeof vi.fn>
const mockedWithTransaction = vi.mocked(withTransaction)
const mockedEnqueueApprovalRequestedNotification = vi.mocked(enqueueApprovalRequestedNotification)

describe('userApprovalRequestService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedQuery.mockReset()
    mockedWithTransaction.mockReset()
    mockedWithTransaction.mockImplementation(async (work: any) =>
      work({ query: mockedQuery } as any)
    )
  })

  describe('allowlistCheck', () => {
    it('returns true when user is in allowlist', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as any)
      const result = await allowlistCheck('ns', 'recipe', 'user-1', undefined)
      expect(result).toBe(true)
    })

    it('returns false when user not in allowlist', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      const result = await allowlistCheck('ns', 'recipe', 'user-1', undefined)
      expect(result).toBe(false)
    })

    it('returns true when team is in allowlist', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as any)
      const result = await allowlistCheck('ns', 'recipe', undefined, 'team-1')
      expect(result).toBe(true)
    })

    it('returns false with no target', async () => {
      const result = await allowlistCheck('ns', 'recipe', undefined, undefined)
      expect(result).toBe(false)
    })
  })

  describe('triggerGrantCheck', () => {
    it('returns true when the target user has a workflow trigger grant', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as any)

      const result = await triggerGrantCheck('ns', 'recipe', 'user-1', undefined)

      expect(result).toBe(true)
      expect(String(mockedQuery.mock.calls[0]?.[0])).toContain('FROM user_workflow_triggers')
    })

    it('returns true when the target team has a workflow trigger grant', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as any)

      const result = await triggerGrantCheck('ns', 'recipe', undefined, 'team-1')

      expect(result).toBe(true)
      const sql = String(mockedQuery.mock.calls[0]?.[0])
      expect(sql).toContain('FROM team_workflow_triggers')
      expect(sql).toContain('team_id = $3')
    })

    it('returns false with no target', async () => {
      const result = await triggerGrantCheck('ns', 'recipe', undefined, undefined)

      expect(result).toBe(false)
      expect(mockedQuery).not.toHaveBeenCalled()
    })
  })

  describe('parseWorkflowTriggerIntent', () => {
    it('returns a trimmed typed intent from payload metadata', () => {
      expect(
        parseWorkflowTriggerIntent({
          message: 'approve',
          metadata: {
            workflowTrigger: {
              namespace: ' sandbox-recipes ',
              name: ' child ',
              caller: ' chatllm ',
            },
          },
        })
      ).toEqual({ namespace: 'sandbox-recipes', name: 'child', caller: 'chatllm' })
    })

    it('returns null for missing, malformed, non-string, or empty fields', () => {
      expect(parseWorkflowTriggerIntent(null)).toBeNull()
      expect(parseWorkflowTriggerIntent({ message: 'none' })).toBeNull()
      expect(parseWorkflowTriggerIntent({ metadata: { workflowTrigger: 'bad' } })).toBeNull()
      expect(
        parseWorkflowTriggerIntent({
          metadata: { workflowTrigger: { namespace: 'ns', name: '', caller: 'host' } },
        })
      ).toBeNull()
      expect(
        parseWorkflowTriggerIntent({
          metadata: { workflowTrigger: { namespace: 'ns', name: 'recipe', caller: 123 } },
        })
      ).toBeNull()
    })
  })

  describe('resolveWorkflowTriggerGrant', () => {
    it('authorizes a direct user grant', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as any)

      const result = await resolveWorkflowTriggerGrant({
        userId: 'user-1',
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        mode: 'direct-user-session',
        currentTeamId: 'team-a',
      })

      expect(result).toEqual({ granted: true, source: 'user', userId: 'user-1' })
      expect(String(mockedQuery.mock.calls[0]?.[0])).toContain('FROM user_workflow_triggers')
    })

    it('authorizes a direct-session team grant only for the current active team', async () => {
      mockedQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        .mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as any)

      const result = await resolveWorkflowTriggerGrant({
        userId: 'user-1',
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        mode: 'direct-user-session',
        currentTeamId: 'team-b',
      })

      expect(result).toEqual({ granted: true, source: 'team', teamId: 'team-b' })
      const teamSql = String(mockedQuery.mock.calls[1]?.[0])
      expect(teamSql).toContain('JOIN team_workflow_triggers')
      expect(teamSql).toContain("tm.status = 'active'")
      expect(mockedQuery.mock.calls[1]?.[1]).toEqual(['user-1', 'team-b', 'ns', 'recipe'])
    })

    it('does not scan other teams when the current session team lacks the grant', async () => {
      mockedQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)

      const result = await resolveWorkflowTriggerGrant({
        userId: 'user-1',
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        mode: 'direct-user-session',
        currentTeamId: 'team-a',
      })

      expect(result).toEqual({ granted: false })
      expect(mockedQuery).toHaveBeenCalledTimes(2)
    })

    it('requires direct user grant for approval-target-user mode', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)

      const result = await resolveWorkflowTriggerGrant({
        userId: 'user-1',
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        mode: 'approval-target-user',
        currentTeamId: 'team-b',
      })

      expect(result).toEqual({ granted: false })
      expect(mockedQuery).toHaveBeenCalledTimes(1)
    })

    it('authorizes target-team mode only through the exact active target team grant', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{ teamGranted: true }], rowCount: 1 } as any)

      const result = await resolveWorkflowTriggerGrant({
        userId: 'user-1',
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        mode: 'approval-target-team',
        targetTeamId: 'team-a',
      })

      expect(result).toEqual({ granted: true, source: 'team', teamId: 'team-a' })
      const teamSql = String(mockedQuery.mock.calls[0]?.[0])
      expect(teamSql).toContain('LEFT JOIN team_workflow_triggers')
      expect(teamSql).toContain("tm.status = 'active'")
      expect(teamSql).not.toContain('user_workflow_triggers')
      expect(mockedQuery.mock.calls[0]?.[1]).toEqual(['user-1', 'team-a', 'ns', 'recipe'])
    })

    it('does not treat team membership alone as a trigger grant', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{ teamGranted: false }], rowCount: 1 } as any)

      const result = await resolveWorkflowTriggerGrant({
        userId: 'user-1',
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        mode: 'approval-target-team',
        targetTeamId: 'team-a',
      })

      expect(result).toEqual({ granted: false })
      expect(mockedQuery).toHaveBeenCalledTimes(1)
    })

    it('does not use a direct user grant to authorize target-team mode', async () => {
      mockedQuery.mockResolvedValueOnce({ rows: [{ teamGranted: false }], rowCount: 1 } as any)

      const result = await resolveWorkflowTriggerGrant({
        userId: 'user-1',
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        mode: 'approval-target-team',
        targetTeamId: 'team-a',
      })

      expect(result).toEqual({ granted: false })
      expect(mockedQuery).toHaveBeenCalledTimes(1)
      expect(String(mockedQuery.mock.calls[0]?.[0])).not.toContain('user_workflow_triggers')
    })
  })

  describe('getApprovalRecipeBinding', () => {
    it('uses only the typed trigger intent table and never falls back to JSON metadata', async () => {
      mockedQuery.mockResolvedValueOnce({
        rows: [
          {
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'child',
            triggerNamespace: null,
            triggerName: null,
            triggerCaller: null,
          },
        ],
        rowCount: 1,
      } as any)

      await expect(getApprovalRecipeBinding('approval-1')).resolves.toEqual({
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'child',
        triggerNamespace: null,
        triggerName: null,
        triggerCaller: null,
      })

      const sql = String(mockedQuery.mock.calls[0]?.[0])
      expect(sql).toContain('LEFT JOIN workflow_approval_trigger_intents')
      expect(sql).toContain('wati.trigger_namespace AS "triggerNamespace"')
      expect(sql).not.toContain("payload->'metadata'->'workflowTrigger'")
      expect(sql).not.toContain('COALESCE(wati')
    })
  })

  describe('assertApprovalTriggerBinding', () => {
    it.each([
      { actorType: 'user', requestedActor: 'user', approvalRequestId: 'approval-user' },
      { actorType: 'admin', requestedActor: 'user', approvalRequestId: 'approval-admin' },
      {
        actorType: 'autonomous',
        requestedActor: 'autonomous',
        approvalRequestId: 'approval-autonomous',
      },
      {
        actorType: 'scheduled',
        requestedActor: 'scheduled',
        approvalRequestId: 'approval-scheduled',
      },
      {
        actorType: null,
        requestedActor: 'autonomous',
        approvalRequestId: 'approval-legacy',
      },
    ] as const)(
      'maps persisted actor type $actorType to $requestedActor',
      async ({ actorType, requestedActor, approvalRequestId }) => {
        mockedQuery.mockResolvedValueOnce({
          rows: [
            {
              status: 'approved',
              triggerNamespace: 'sandbox-recipes',
              triggerName: 'target',
              triggerCaller: 'sandbox-recipes/caller',
              actorType,
            },
          ],
          rowCount: 1,
        } as any)

        await expect(
          assertApprovalTriggerBinding({
            approvalRequestId,
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'target',
            callerKey: 'sandbox-recipes/caller',
          })
        ).resolves.toEqual({ requestedActor })

        const sql = String(mockedQuery.mock.calls[0]?.[0])
        expect(sql).toContain('LEFT JOIN workflow_approval_trigger_intents')
        expect(sql).toContain('LEFT JOIN workflow_approval_trigger_run_intents')
        expect(sql).toContain('watri.actor_type AS "actorType"')
        expect(sql).not.toContain("payload->'metadata'->'workflowTrigger'")
      }
    )

    it.each([
      'chatllm',
      'sandbox-recipes/workflow-caller-alpha',
      'sandbox-recipes/workflow-caller-beta',
    ])('accepts typed trigger intent for caller key %s', async callerKey => {
      mockedQuery.mockResolvedValueOnce({
        rows: [
          {
            status: 'approved',
            triggerNamespace: 'sandbox-recipes',
            triggerName: 'target',
            triggerCaller: callerKey,
          },
        ],
        rowCount: 1,
      } as any)

      await expect(
        assertApprovalTriggerBinding({
          approvalRequestId: 'approval-variant',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'target',
          callerKey,
        })
      ).resolves.toEqual({ requestedActor: 'autonomous' })
    })

    it('rejects a trigger preflight when the typed caller or target recipe mismatches', async () => {
      mockedQuery.mockResolvedValueOnce({
        rows: [
          {
            status: 'approved',
            triggerNamespace: 'sandbox-recipes',
            triggerName: 'other',
            triggerCaller: 'sandbox-recipes/caller',
          },
        ],
        rowCount: 1,
      } as any)

      await expect(
        assertApprovalTriggerBinding({
          approvalRequestId: 'approval-1',
          recipeNamespace: 'sandbox-recipes',
          recipeName: 'target',
          callerKey: 'sandbox-recipes/caller',
        })
      ).rejects.toMatchObject({
        code: 'approval_trigger_binding_mismatch',
        approvalStatus: 'approved',
      })
    })
  })

  describe('createApprovalRequest', () => {
    it('creates new request when no idempotency collision', async () => {
      mockedQuery.mockResolvedValueOnce({
        rows: [{ id: 'new-id', expires_at: '2026-01-01T00:00:00Z', status: 'pending' }],
        rowCount: 1,
      } as any)

      const result = await createApprovalRequest({
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        targetUserId: 'user-1',
        payload: { message: 'test' },
        idempotencyKey: 'key-1',
      })

      expect(result).toMatchObject({ id: 'new-id', status: 'pending' })
      expect('existing' in result).toBe(false)
      expect(mockedEnqueueApprovalRequestedNotification).toHaveBeenCalledWith(
        { query: mockedQuery },
        expect.objectContaining({
          approvalRequestId: 'new-id',
          recipeNamespace: 'ns',
          recipeName: 'recipe',
          targetUserId: 'user-1',
        })
      )
    })

    it('returns existing on idempotency collision with matching payload hash', async () => {
      // Precompute hash the service will calculate for this exact body.
      const expectedHash = (
        await import('../src/services/userApprovalRequestService.js')
      ).computePayloadHash({
        targetUserId: 'user-1',
        payload: { message: 'test' },
        ttlSeconds: 300,
      })
      mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any).mockResolvedValueOnce({
        rows: [{ id: 'existing-id', status: 'pending', payloadHash: expectedHash }],
        rowCount: 1,
      } as any)

      const result = await createApprovalRequest({
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        targetUserId: 'user-1',
        payload: { message: 'test' },
        idempotencyKey: 'dup-key',
        ttlSeconds: 300,
      })

      expect(result).toMatchObject({ id: 'existing-id', status: 'pending' })
      expect('existing' in result).toBe(true)
      expect('mismatch' in result).toBe(false)
      expect(mockedEnqueueApprovalRequestedNotification).not.toHaveBeenCalled()
    })

    it('returns mismatch when idempotency key is reused with a different message', async () => {
      // Stored row's hash is derived from message="original"; caller sends "changed".
      const { computePayloadHash } = await import('../src/services/userApprovalRequestService.js')
      const existingHash = computePayloadHash({
        targetUserId: 'user-1',
        payload: { message: 'original' },
        ttlSeconds: 300,
      })

      mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any).mockResolvedValueOnce({
        rows: [{ id: 'existing-id', status: 'pending', payloadHash: existingHash }],
        rowCount: 1,
      } as any)

      const result = await createApprovalRequest({
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        targetUserId: 'user-1',
        payload: { message: 'changed' },
        idempotencyKey: 'dup-key',
        ttlSeconds: 300,
      })

      expect('mismatch' in result).toBe(true)
      expect(result).toMatchObject({
        mismatch: true,
        existingId: 'existing-id',
        existingStatus: 'pending',
      })
    })

    it('returns mismatch when idempotency key is reused with a different target', async () => {
      const { computePayloadHash } = await import('../src/services/userApprovalRequestService.js')
      const existingHash = computePayloadHash({
        targetUserId: 'user-1',
        payload: { message: 'test' },
        ttlSeconds: 300,
      })

      mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any).mockResolvedValueOnce({
        rows: [{ id: 'existing-id', status: 'pending', payloadHash: existingHash }],
        rowCount: 1,
      } as any)

      // Same message, same key, but different target user → must mismatch.
      const result = await createApprovalRequest({
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        targetUserId: 'user-2',
        payload: { message: 'test' },
        idempotencyKey: 'dup-key',
        ttlSeconds: 300,
      })

      expect('mismatch' in result).toBe(true)
      expect(result).toMatchObject({
        mismatch: true,
        existingId: 'existing-id',
        existingStatus: 'pending',
      })
    })

    it('allows different idempotency keys with the same payload to create new rows', async () => {
      mockedQuery.mockResolvedValueOnce({
        rows: [{ id: 'brand-new', expires_at: '2026-01-01T00:00:00Z', status: 'pending' }],
        rowCount: 1,
      } as any)

      const result = await createApprovalRequest({
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        targetUserId: 'user-1',
        payload: { message: 'test' },
        idempotencyKey: 'different-key',
        ttlSeconds: 300,
      })

      expect(result).toMatchObject({ id: 'brand-new', status: 'pending' })
      expect('existing' in result).toBe(false)
      expect('mismatch' in result).toBe(false)
    })

    it('treats legacy rows with empty payload_hash as compatible (pre-migration idempotency)', async () => {
      // Rows created before payload_hash existed carry the default '' and must
      // keep returning existing:true to stay idempotent for in-flight callers.
      mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any).mockResolvedValueOnce({
        rows: [{ id: 'legacy-id', status: 'pending', payloadHash: '' }],
        rowCount: 1,
      } as any)

      const result = await createApprovalRequest({
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        targetUserId: 'user-1',
        payload: { message: 'test' },
        idempotencyKey: 'dup-key',
        ttlSeconds: 300,
      })

      expect('mismatch' in result).toBe(false)
      expect(result).toMatchObject({ id: 'legacy-id', status: 'pending' })
      expect('existing' in result).toBe(true)
    })

    it('dual-writes typed workflow trigger intent for trigger-bound approvals', async () => {
      mockedQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'new-id', expires_at: '2026-01-01T00:00:00Z', status: 'pending' }],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)

      const result = await createApprovalRequest({
        recipeNamespace: 'ns',
        recipeName: 'recipe',
        targetUserId: 'user-1',
        payload: {
          message: 'test',
          metadata: {
            workflowTrigger: {
              namespace: 'sandbox-recipes',
              name: 'child',
              caller: 'chatllm',
            },
          },
        },
        idempotencyKey: 'key-trigger',
      })

      expect(result).toMatchObject({ id: 'new-id', status: 'pending' })
      expect(mockedQuery).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('INSERT INTO workflow_approval_trigger_intents'),
        ['new-id', 'sandbox-recipes', 'child', 'chatllm']
      )
      expect(mockedEnqueueApprovalRequestedNotification).toHaveBeenCalledWith(
        { query: mockedQuery },
        expect.objectContaining({
          approvalRequestId: 'new-id',
          recipeNamespace: 'ns',
          recipeName: 'recipe',
        })
      )
    })

    it('rejects approval creation when atomic notification enqueue fails', async () => {
      mockedQuery.mockResolvedValueOnce({
        rows: [{ id: 'new-id', expires_at: '2026-01-01T00:00:00Z', status: 'pending' }],
        rowCount: 1,
      } as any)
      mockedEnqueueApprovalRequestedNotification.mockRejectedValueOnce(new Error('enqueue failed'))

      await expect(
        createApprovalRequest({
          recipeNamespace: 'ns',
          recipeName: 'recipe',
          targetUserId: 'user-1',
          payload: { message: 'test' },
          idempotencyKey: 'key-notification-fails',
        })
      ).rejects.toThrow('enqueue failed')
    })

    it('rejects trigger-bound approvals with malformed workflow trigger intent', async () => {
      await expect(
        createApprovalRequest({
          recipeNamespace: 'ns',
          recipeName: 'recipe',
          targetUserId: 'user-1',
          payload: {
            message: 'test',
            metadata: { workflowTrigger: { namespace: 'ns', name: '', caller: 'host' } },
          },
          idempotencyKey: 'bad-trigger',
        })
      ).rejects.toThrow(InvalidWorkflowTriggerIntentError)
      expect(mockedQuery).not.toHaveBeenCalled()
    })
  })

  describe('getStatus', () => {
    it('queries camelCase aliases for expiresAt and decisionMaker (pending, not expired)', async () => {
      const future = new Date(Date.now() + 60_000).toISOString()
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'approval-1',
            recipeNamespace: 'ns',
            recipeName: 'recipe',
            requestedAt: '2026-01-01T00:00:00Z',
            expiresAt: future,
            status: 'pending',
            targetUserId: 'user-1',
            targetTeamId: null,
            payload: { message: 'test' },
            decisionMaker: null,
            idempotencyKey: 'idem-1',
            correlation: { stepId: 'step-1' },
          },
        ],
        rowCount: 1,
      } as any)

      mockedWithTransaction.mockImplementationOnce(async (work: any) => work(mockDb))

      const result = await getStatus('approval-1', 'ns', 'recipe')

      expect(result?.expiresAt).toBe(future)
      expect(result?.status).toBe('pending')
      expect(result?.decisionMaker).toBeNull()
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('expires_at AS "expiresAt"'),
        ['approval-1', 'ns', 'recipe']
      )
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('decision_maker AS "decisionMaker"'),
        ['approval-1', 'ns', 'recipe']
      )
      // Row is fresh — no UPDATE should have been issued.
      expect(mockDb.query).toHaveBeenCalledTimes(1)
    })

    it('returns null when the approval is not found', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      mockedWithTransaction.mockImplementationOnce(async (work: any) => work(mockDb))

      const result = await getStatus('missing', 'ns', 'recipe')
      expect(result).toBeNull()
    })

    it('lazily flips pending → expired when expiresAt is in the past and persists the UPDATE', async () => {
      const past = new Date(Date.now() - 60_000).toISOString()
      const mockDb = { query: vi.fn() }
      mockDb.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'approval-expired',
              recipeNamespace: 'ns',
              recipeName: 'recipe',
              requestedAt: '2026-01-01T00:00:00Z',
              expiresAt: past,
              status: 'pending',
              targetUserId: 'user-1',
              targetTeamId: null,
              payload: { message: 'late' },
              decisionMaker: null,
              idempotencyKey: 'idem-late',
              correlation: null,
            },
          ],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)

      mockedWithTransaction.mockImplementationOnce(async (work: any) => work(mockDb))

      const result = await getStatus('approval-expired', 'ns', 'recipe')

      expect(result?.status).toBe('expired')
      expect(result?.expiresAt).toBe(past)
      // Second call must be the UPDATE ... SET status='expired' ... WHERE status='pending'
      expect(mockDb.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("SET status = 'expired'"),
        ['approval-expired']
      )
    })

    it('does NOT touch terminal rows even if expiresAt is in the past (approved stays approved)', async () => {
      const past = new Date(Date.now() - 60_000).toISOString()
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'approval-approved',
            recipeNamespace: 'ns',
            recipeName: 'recipe',
            requestedAt: '2026-01-01T00:00:00Z',
            expiresAt: past,
            status: 'approved',
            targetUserId: 'user-1',
            targetTeamId: null,
            payload: { message: 'done' },
            decisionMaker: { userId: 'u1', decidedAt: '2026-01-01T00:05:00Z' },
            idempotencyKey: 'idem-done',
            correlation: null,
          },
        ],
        rowCount: 1,
      } as any)

      mockedWithTransaction.mockImplementationOnce(async (work: any) => work(mockDb))

      const result = await getStatus('approval-approved', 'ns', 'recipe')

      expect(result?.status).toBe('approved')
      // Terminal row: NO UPDATE should have been issued.
      expect(mockDb.query).toHaveBeenCalledTimes(1)
    })

    it('uses SELECT ... FOR UPDATE to serialise concurrent lazy expirations', async () => {
      const past = new Date(Date.now() - 60_000).toISOString()
      const mockDb = { query: vi.fn() }
      mockDb.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'approval-race',
              recipeNamespace: 'ns',
              recipeName: 'recipe',
              requestedAt: '2026-01-01T00:00:00Z',
              expiresAt: past,
              status: 'pending',
              targetUserId: 'user-1',
              targetTeamId: null,
              payload: { message: 'race' },
              decisionMaker: null,
              idempotencyKey: 'idem-race',
              correlation: null,
            },
          ],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)

      mockedWithTransaction.mockImplementationOnce(async (work: any) => work(mockDb))

      await getStatus('approval-race', 'ns', 'recipe')

      // The SELECT must request a row-level lock so a concurrent getStatus
      // (or recordDecision) cannot double-update the row.
      const selectCall = mockDb.query.mock.calls[0]?.[0] as string
      expect(selectCall).toMatch(/FOR UPDATE/)
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('decided_at = COALESCE(decided_at, NOW())'),
        ['approval-race']
      )
    })
  })

  describe('recordDecision', () => {
    it('approves a pending request', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ status: 'pending', isExpired: false }],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)

      mockedWithTransaction.mockImplementationOnce(async (work: any) => work(mockDb))

      const result = await recordDecision('id-1', 'approve', { userId: 'u1' })
      expect(result).toMatchObject({ ok: true })
    })

    it('does not record a team workflow decision from a different requester', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            status: 'pending',
            isExpired: false,
            targetUserId: null,
            targetTeamId: 'team-1',
            payload: {
              message: 'Approve workflow trigger',
              metadata: {
                workflowTrigger: {
                  namespace: 'ns',
                  name: 'recipe',
                  caller: 'ns/recipe',
                  requesterUserId: 'u1',
                },
              },
            },
          },
        ],
        rowCount: 1,
      } as any)

      mockedWithTransaction.mockImplementationOnce(async (work: any) => work(mockDb))

      const result = await recordDecision('id-1', 'approve', {
        userId: 'u2',
        teamId: 'team-1',
      })

      expect(result).toEqual({ ok: false, error: 'approval_requester_mismatch' })
      expect(mockDb.query).toHaveBeenCalledTimes(1)
    })

    it('creates and consumes a workflow run when approving a stored trigger run intent', async () => {
      const mockDb = { query: vi.fn() }
      const runRow = {
        run_id: 'run-1',
        recipe_namespace: 'ns',
        recipe_name: 'recipe',
        phase: 'Pending',
        actor_type: 'user',
        actor_id: '00000000-0000-4000-8000-000000000001',
        team_id: null,
        usage_team_id: null,
        idempotency_key: 'idem-1',
        trigger_source: 'onDemand',
        inputs: {},
        intermediate_parameters: null,
        output_overrides: null,
        child_recipe_name: null,
        child_recipe_namespace: null,
        owner_instance_id: null,
        max_duration_seconds: 60,
        ttl_seconds_after_finished: 3600,
        approval_request_id: 'id-1',
        idempotency_payload_hash: 'hash-1',
        started_at: null,
        completed_at: null,
        last_reconciled_at: null,
        created_at: '2026-04-20T10:05:00.000Z',
        updated_at: '2026-04-20T10:05:00.000Z',
      }
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ status: 'pending', isExpired: false }],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
        .mockResolvedValueOnce({
          rows: [
            {
              recipeNamespace: 'ns',
              recipeName: 'recipe',
              callerKey: 'external-rest-api:user:u1:team:t1',
              actorType: 'user',
              actorId: '00000000-0000-4000-8000-000000000001',
              teamId: null,
              usageTeamId: null,
              triggerSource: 'onDemand',
              idempotencyKey: 'idem-1',
              inputs: {},
              intermediateParameters: null,
              outputOverrides: null,
              maxDurationSeconds: 60,
              ttlSecondsAfterFinished: 3600,
              idempotencyPayloadHash: 'hash-1',
            },
          ],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        .mockResolvedValueOnce({
          rows: [
            {
              status: 'approved',
              recipeNamespace: 'ns',
              recipeName: 'recipe',
              isExpired: false,
              targetUserId: 'u1',
              targetTeamId: null,
              decidedByUserId: 'u1',
              triggerNamespace: 'ns',
              triggerName: 'recipe',
              triggerCaller: 'external-rest-api:user:u1:team:t1',
              targetUserAllowed: true,
              targetTeamAllowed: false,
            },
          ],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [{ '1': 1 }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [{ teamId: null }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [runRow], rowCount: 1 } as any)

      mockedWithTransaction.mockImplementationOnce(async (work: any) => work(mockDb))

      const result = await recordDecision('id-1', 'approve', { userId: 'u1' })
      expect(result).toMatchObject({
        ok: true,
        workflowRun: { row: expect.objectContaining({ run_id: 'run-1' }), created: true },
      })
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE workflow_approval_requests war'),
        ['id-1', 'ns', 'recipe', 'external-rest-api:user:u1:team:t1']
      )
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO workflow_runs'),
        expect.arrayContaining(['ns', 'recipe', 'user', 'idem-1'])
      )
    })

    it('rejects and expires a pending request that is already past expires_at', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ status: 'pending', isExpired: true }],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)

      mockedWithTransaction.mockImplementationOnce(async (work: any) => work(mockDb))

      const result = await recordDecision('id-1', 'approve', { userId: 'u1' })
      expect(result).toMatchObject({ ok: false, error: 'expired' })
      expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'expired'"), [
        'id-1',
      ])
    })

    it('rejects non-pending request', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({ rows: [{ status: 'approved' }], rowCount: 1 } as any)

      mockedWithTransaction.mockImplementationOnce(async (work: any) => work(mockDb))

      const result = await recordDecision('id-1', 'approve', { userId: 'u1' })
      expect(result).toMatchObject({ ok: false, error: 'not_pending' })
    })
  })

  describe('cancelRequest', () => {
    it('cancels a pending request', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ status: 'pending' }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [{ id: 'id-1' }], rowCount: 1 } as any)

      mockedWithTransaction.mockImplementationOnce(async (work: any) => work(mockDb))

      const result = await cancelRequest('id-1', 'ns', 'recipe')
      expect(result).toMatchObject({ ok: true })
    })

    it('returns not_found for unknown request', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)

      mockedWithTransaction.mockImplementationOnce(async (work: any) => work(mockDb))

      const result = await cancelRequest('id-1', 'ns', 'recipe')
      expect(result).toMatchObject({ ok: false, error: 'not_found' })
    })

    it('returns not_pending for already-decided request', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({ rows: [{ status: 'approved' }], rowCount: 1 } as any)

      mockedWithTransaction.mockImplementationOnce(async (work: any) => work(mockDb))

      const result = await cancelRequest('id-1', 'ns', 'recipe')
      expect(result).toMatchObject({ ok: false, error: 'not_pending' })
    })

    it('marks an already-expired pending request with decided_at', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ status: 'pending', expires_at: '2000-01-01T00:00:00.000Z' }],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)

      mockedWithTransaction.mockImplementationOnce(async (work: any) => work(mockDb))

      const result = await cancelRequest('id-1', 'ns', 'recipe')

      expect(result).toMatchObject({ ok: false, error: 'expired' })
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('decided_at = COALESCE(decided_at, NOW())'),
        ['id-1']
      )
    })
  })

  describe('consumeApprovalForTrigger', () => {
    function approvalRow(overrides: Record<string, unknown> = {}) {
      return {
        status: 'approved',
        recipeNamespace: 'mcp-host',
        recipeName: 'standalone',
        isExpired: false,
        targetUserId: 'user-1',
        targetTeamId: null,
        decidedByUserId: 'user-1',
        triggerNamespace: 'ns',
        triggerName: 'recipe',
        triggerCaller: 'ns/recipe',
        targetUserAllowed: true,
        targetTeamAllowed: false,
        payload: null,
        ...overrides,
      }
    }

    it('throws if approval not found', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)

      await expect(
        consumeApprovalForTrigger(
          {
            approvalRequestId: 'nonexistent',
            recipeNamespace: 'ns',
            recipeName: 'recipe',
            callerKey: 'ns/recipe',
            correlationId: 'corr-1',
          },
          mockDb as any
        )
      ).rejects.toThrow('not found')
    })

    it("throws if approval status is not 'approved'", async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({
        rows: [approvalRow({ status: 'pending' })],
        rowCount: 1,
      } as any)

      await expect(
        consumeApprovalForTrigger(
          {
            approvalRequestId: 'id-pending',
            recipeNamespace: 'ns',
            recipeName: 'recipe',
            callerKey: 'ns/recipe',
            correlationId: 'corr-2',
          },
          mockDb as any
        )
      ).rejects.toThrow("cannot be consumed: status is 'pending'")
    })

    it("throws if approval status is 'denied'", async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({
        rows: [approvalRow({ status: 'denied' })],
        rowCount: 1,
      } as any)

      await expect(
        consumeApprovalForTrigger(
          {
            approvalRequestId: 'id-denied',
            recipeNamespace: 'ns',
            recipeName: 'recipe',
            callerKey: 'ns/recipe',
            correlationId: 'corr-3',
          },
          mockDb as any
        )
      ).rejects.toThrow("cannot be consumed: status is 'denied'")
    })

    it('throws if trigger metadata does not match the mcp-host-control caller', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({
        rows: [approvalRow({ triggerCaller: 'other-caller' })],
        rowCount: 1,
      } as any)

      await expect(
        consumeApprovalForTrigger(
          {
            approvalRequestId: 'id-wrong-caller',
            recipeNamespace: 'ns',
            recipeName: 'recipe',
            callerKey: 'ns/recipe',
            correlationId: 'corr-binding',
          },
          mockDb as any
        )
      ).rejects.toThrow(
        'trigger binding mismatch (ns/recipe caller=other-caller actual, ns/recipe caller=ns/recipe expected)'
      )
    })

    it('rejects caller swap when beta consumes an approval created for alpha', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({
        rows: [
          approvalRow({
            triggerNamespace: 'sandbox-recipes',
            triggerName: 'target',
            triggerCaller: 'sandbox-recipes/workflow-caller-alpha',
          }),
        ],
        rowCount: 1,
      } as any)

      await expect(
        consumeApprovalForTrigger(
          {
            approvalRequestId: 'id-alpha-approval',
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'target',
            callerKey: 'sandbox-recipes/workflow-caller-beta',
            correlationId: 'corr-caller-swap',
          },
          mockDb as any
        )
      ).rejects.toThrow(
        'trigger binding mismatch (sandbox-recipes/target caller=sandbox-recipes/workflow-caller-alpha actual, sandbox-recipes/target caller=sandbox-recipes/workflow-caller-beta expected)'
      )
      expect(mockDb.query).toHaveBeenCalledTimes(1)
    })

    it('rejects JSON-only trigger approvals that lack typed intent rows', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({
        rows: [
          approvalRow({
            triggerNamespace: null,
            triggerName: null,
            triggerCaller: null,
          }),
        ],
        rowCount: 1,
      } as any)

      await expect(
        consumeApprovalForTrigger(
          {
            approvalRequestId: 'id-json-only-window',
            recipeNamespace: 'ns',
            recipeName: 'recipe',
            callerKey: 'ns/recipe',
            correlationId: 'corr-json-only',
          },
          mockDb as any
        )
      ).rejects.toThrow(
        'trigger binding mismatch (<missing>/<missing> caller=<missing> actual, ns/recipe caller=ns/recipe expected)'
      )

      expect(mockDb.query).toHaveBeenCalledTimes(1)
    })

    it('throws if an approved target is no longer allowlisted', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({
        rows: [approvalRow({ targetUserAllowed: false })],
        rowCount: 1,
      } as any)

      await expect(
        consumeApprovalForTrigger(
          {
            approvalRequestId: 'id-revoked-target',
            recipeNamespace: 'ns',
            recipeName: 'recipe',
            callerKey: 'ns/recipe',
            correlationId: 'corr-target',
          },
          mockDb as any
        )
      ).rejects.toThrow('target no longer allowed')
    })

    it('throws if a team approval decider is no longer an active team member', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query
        .mockResolvedValueOnce({
          rows: [
            approvalRow({
              targetUserId: null,
              targetTeamId: 'team-1',
              targetUserAllowed: false,
              targetTeamAllowed: true,
            }),
          ],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)

      await expect(
        consumeApprovalForTrigger(
          {
            approvalRequestId: 'id-team-revoked',
            recipeNamespace: 'ns',
            recipeName: 'recipe',
            callerKey: 'ns/recipe',
            correlationId: 'corr-team',
          },
          mockDb as any
        )
      ).rejects.toThrow('team decider is no longer active')
    })

    it('throws a target invariant error when an approval has no target', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({
        rows: [approvalRow({ targetUserId: null, targetTeamId: null })],
        rowCount: 1,
      } as any)

      await expect(
        consumeApprovalForTrigger(
          {
            approvalRequestId: 'id-missing-target',
            recipeNamespace: 'ns',
            recipeName: 'recipe',
            callerKey: 'ns/recipe',
            correlationId: 'corr-missing-target',
          },
          mockDb as any
        )
      ).rejects.toMatchObject({ code: 'approval_target_missing' })
    })

    it("succeeds when status is 'approved' and the target user has a direct grant", async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query
        .mockResolvedValueOnce({ rows: [approvalRow()], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as any)
        .mockResolvedValueOnce({
          rows: [{ teamId: '11111111-1111-4111-8111-111111111111' }],
          rowCount: 1,
        } as any)

      await expect(
        consumeApprovalForTrigger(
          {
            approvalRequestId: 'id-approved',
            recipeNamespace: 'ns',
            recipeName: 'recipe',
            callerKey: 'ns/recipe',
            correlationId: 'corr-4',
          },
          mockDb as any
        )
      ).resolves.toEqual({ teamId: '11111111-1111-4111-8111-111111111111' })

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'consumed'"),
        ['id-approved', 'ns', 'recipe', 'ns/recipe']
      )
      const selectSql = mockDb.query.mock.calls[0]?.[0] as string
      expect(selectSql).toContain('LEFT JOIN workflow_approval_trigger_intents')
      expect(selectSql).toContain('FOR UPDATE OF war')
      expect(selectSql).toContain('war.payload')
      const updateSql = mockDb.query.mock.calls[2]?.[0] as string
      expect(updateSql).toContain('workflow_approval_trigger_intents')
      expect(updateSql).toContain('user_workflow_triggers trigger_uwt')
      expect(updateSql).toContain('war.target_user_id::text = war.decided_by_user_id')
      expect(updateSql).toContain('trigger_uwt.user_id::text = war.decided_by_user_id')
      expect(updateSql).toContain('tm.user_id::text = war.decided_by_user_id')
      expect(updateSql).toContain('workflow_recipe_allowed_teams')
      expect(updateSql).toContain('team_workflow_triggers twt')
      expect(updateSql).toContain("payload->'metadata'->'workflowTrigger'->>'requesterUserId'")
      const teamBranch = updateSql.slice(updateSql.indexOf('war.target_team_id IS NOT NULL'))
      expect(teamBranch).not.toContain('user_workflow_triggers trigger_uwt')
    })

    it('fails if authorization changes before the final consume update', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query
        .mockResolvedValueOnce({ rows: [approvalRow()], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)

      await expect(
        consumeApprovalForTrigger(
          {
            approvalRequestId: 'id-revoked-before-update',
            recipeNamespace: 'ns',
            recipeName: 'recipe',
            callerKey: 'ns/recipe',
            correlationId: 'corr-revoked',
          },
          mockDb as any
        )
      ).rejects.toThrow('authorization changed before consumption')
    })

    it('succeeds for target-team approvals through the exact context-bound team grant', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query
        .mockResolvedValueOnce({
          rows: [
            approvalRow({
              targetUserId: null,
              targetTeamId: 'team-1',
              targetUserAllowed: false,
              targetTeamAllowed: true,
            }),
          ],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [{ teamGranted: true }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [{ teamId: 'team-1' }], rowCount: 1 } as any)

      await expect(
        consumeApprovalForTrigger(
          {
            approvalRequestId: 'id-team',
            recipeNamespace: 'ns',
            recipeName: 'recipe',
            callerKey: 'ns/recipe',
            correlationId: 'corr-team',
          },
          mockDb as any
        )
      ).resolves.toEqual({ teamId: 'team-1' })

      expect(mockDb.query.mock.calls[1]?.[1]).toEqual(['user-1', 'team-1', 'ns', 'recipe'])
    })

    it('rejects target-team approvals when another user decides a requester-bound workflow', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query.mockResolvedValueOnce({
        rows: [
          approvalRow({
            targetUserId: null,
            targetTeamId: 'team-1',
            targetUserAllowed: false,
            targetTeamAllowed: true,
            decidedByUserId: 'user-2',
            payload: {
              message: 'Approve workflow trigger',
              metadata: {
                workflowTrigger: {
                  namespace: 'ns',
                  name: 'recipe',
                  caller: 'ns/recipe',
                  requesterUserId: 'user-1',
                },
              },
            },
          }),
        ],
        rowCount: 1,
      } as any)

      await expect(
        consumeApprovalForTrigger(
          {
            approvalRequestId: 'id-team-requester-mismatch',
            recipeNamespace: 'ns',
            recipeName: 'recipe',
            callerKey: 'ns/recipe',
            correlationId: 'corr-team-requester',
          },
          mockDb as any
        )
      ).rejects.toMatchObject({ code: 'approval_requester_mismatch' })

      expect(mockDb.query).toHaveBeenCalledTimes(1)
    })

    it('allows parent-scoped approval rows to authorize child workflow targets via typed intent', async () => {
      const mockDb = { query: vi.fn() }
      mockDb.query
        .mockResolvedValueOnce({
          rows: [
            approvalRow({
              recipeNamespace: 'mcp-host',
              recipeName: 'standalone',
              triggerNamespace: 'sandbox-recipes',
              triggerName: 'child-recipe',
              triggerCaller: 'sandbox-recipes/child-recipe',
            }),
          ],
          rowCount: 1,
        } as any)
        .mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [{ teamId: null }], rowCount: 1 } as any)

      await expect(
        consumeApprovalForTrigger(
          {
            approvalRequestId: 'id-parent-scope',
            recipeNamespace: 'sandbox-recipes',
            recipeName: 'child-recipe',
            callerKey: 'sandbox-recipes/child-recipe',
            correlationId: 'corr-child',
          },
          mockDb as any
        )
      ).resolves.toEqual({ teamId: null })

      const selectSql = mockDb.query.mock.calls[0]?.[0] as string
      expect(selectSql).toContain('workflow_approval_trigger_intents')
      expect(selectSql).toContain('war.payload')
      expect(selectSql).not.toMatch(
        /AND\s+war\.recipe_namespace\s*=\s*\$2\s+AND\s+war\.recipe_name\s*=\s*\$3/
      )
    })
  })

  describe('expirePendingRequests', () => {
    it('returns count of expired requests', async () => {
      mockedQuery.mockResolvedValueOnce({
        rows: [{ id: 'id-1' }, { id: 'id-2' }],
        rowCount: 2,
      } as any)
      const count = await expirePendingRequests()
      expect(count).toBe(2)
    })
  })
})
