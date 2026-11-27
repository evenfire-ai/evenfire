import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseError } from 'pg'
import { actionBehaviorBindingHash } from '@clerum/action-context-contracts'
import { rootLogger } from '../src/observability/logger.js'
import {
  AccessExecutionBudget,
  AccessExecutionCancelledError,
} from '../src/services/access/accessExecutionBudget.js'
import { knownBehavior } from '../src/services/access/accessPath.js'

const deps = vi.hoisted(() => ({
  authorizeActionV2: vi.fn(),
  resolveActionDestination: vi.fn(),
}))

vi.mock('../src/services/access/actionAuthorizer.js', () => ({
  authorizeActionV2: deps.authorizeActionV2,
}))
vi.mock('../src/services/access/actionDestination.js', () => ({
  resolveActionDestination: deps.resolveActionDestination,
}))

const { revalidateWorkflowTriggerCheckpoint } =
  await import('../src/services/workflows/workflowTriggerCheckpointRevalidation.js')

const userId = '10000000-0000-4000-8000-000000000001'
const sid = '20000000-0000-4000-8000-000000000002'
const accessPathId = `ap1_${'a'.repeat(43)}`
const authorizationRevision = `ar1_${'b'.repeat(43)}`
const targetHash = `ath2_${'c'.repeat(43)}`
const target = Object.freeze({ recipeNamespace: 'sandbox-recipes', recipeName: 'nightly' })
const resource = Object.freeze({
  environmentId: 'development:local',
  type: 'workflow_recipe',
  canonicalId: 'workflow_recipe:development:local:sandbox-recipes/nightly',
  logicalId: 'sandbox-recipes/nightly',
  displayName: 'sandbox-recipes/nightly',
})
const behavior = {
  capabilities: ['workflow.trigger'],
  budget: knownBehavior(null),
  credentialPolicy: knownBehavior(null),
  approvalPolicy: knownBehavior(null),
  filesystemScope: knownBehavior(null),
  runtime: knownBehavior(null),
  providerModelPolicy: knownBehavior(null),
  audit: knownBehavior(null),
}
const behaviorBindingHash = actionBehaviorBindingHash({
  accessPathId,
  authorizationRevision,
  behavior,
} as never)

const request = {
  version: 2,
  principal: { sub: userId, sid, sessionVersion: 1 },
  delegationJti: '30000000-0000-4000-8000-000000000003',
  resource,
  operationId: 'workflow.trigger',
  target,
  targetHash,
  accessPathId,
  authorizationRevision,
  behaviorBindingHash,
}
const caller = { service: 'workflow-recipes', trustPlane: 'internal_control_jwt' } as const
const storedRow = {
  binding_kind: 'trigger',
  path_kind: 'direct',
  effective_team_id: null,
}
const allowed = {
  status: 'allowed',
  context: {
    pathKind: 'direct',
    effectiveTeamId: null,
    targetHash,
    behavior,
    validUntil: null,
    resource,
    target,
    authorizationRevision,
    principal: { userId, sid, sessionVersion: 1 },
  },
}

type Query = { stored: ReturnType<typeof vi.fn> }

// The stored-binding statement is the only statement revalidation sends itself.
function database(query: Query) {
  return {
    query: (text: string, values: unknown[]) => query.stored(text, values),
  }
}

function pgError(code: string): DatabaseError {
  return Object.assign(new DatabaseError('database failure', 0, 'error'), { code })
}

type Site = Readonly<{
  stage: string
  // Make this site's dependency fail with `error`.
  fail: (query: Query, error: unknown) => void
  // The dependency the site called (its liveness witness).
  called: (query: Query) => ReturnType<typeof vi.fn>
  // A failure the site's dependency reports when it cannot answer.
  outage: () => unknown
}>

const SITES: readonly Site[] = [
  {
    stage: 'stored_binding',
    fail: (query, error) => query.stored.mockRejectedValue(error),
    called: query => query.stored,
    // The driver's plain Error: the pool could not hand out a connection.
    outage: () => new Error('timeout exceeded when trying to connect'),
  },
  {
    stage: 'path_resolution',
    fail: (_query, error) => deps.authorizeActionV2.mockRejectedValueOnce(error),
    called: () => deps.authorizeActionV2,
    outage: () => new AccessExecutionCancelledError('deadline'),
  },
  {
    stage: 'selected_path_resolution',
    fail: (_query, error) => {
      deps.authorizeActionV2.mockResolvedValueOnce({
        status: 'access_path_required',
        paths: [{ id: accessPathId, kind: 'direct' }],
      })
      deps.authorizeActionV2.mockRejectedValueOnce(error)
    },
    called: () => deps.authorizeActionV2,
    outage: () => new AccessExecutionCancelledError('deadline'),
  },
  {
    stage: 'destination',
    fail: (_query, error) => deps.resolveActionDestination.mockRejectedValue(error),
    called: () => deps.resolveActionDestination,
    outage: () => new AccessExecutionCancelledError('cancelled'),
  },
]

describe('workflow trigger checkpoint revalidation failures (C12 Q7 siblings)', () => {
  let budget: AccessExecutionBudget
  let query: Query
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    budget = AccessExecutionBudget.create('action')
    query = {
      stored: vi.fn(async () => ({ rows: [storedRow], rowCount: 1 })),
    }
    deps.authorizeActionV2.mockResolvedValue(allowed)
    deps.resolveActionDestination.mockResolvedValue({ status: 'resolved', destination: null })
    warn = vi.spyOn(rootLogger, 'warn').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    warn.mockRestore()
    budget.close()
  })

  function revalidate() {
    return revalidateWorkflowTriggerCheckpoint({
      request: request as never,
      caller,
      gateway: {} as never,
      budget,
      db: database(query),
    })
  }

  it('allows the exact persisted trigger when every dependency answers', async () => {
    const result = await revalidate()

    expect(result).toMatchObject({ status: 'allowed', authorizationRevision })
    // Liveness for the table below: every site's dependency runs on this path.
    expect(query.stored).toHaveBeenCalledTimes(1)
    expect(deps.authorizeActionV2).toHaveBeenCalledTimes(1)
    expect(deps.resolveActionDestination).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it.each(SITES.map(site => [site.stage, site] as const))(
    '%s: a dependency failure is the retryable authority_unavailable, logged by stage',
    async (stage, site) => {
      site.fail(query, site.outage())

      const result = await revalidate()

      expect(result).toEqual({
        version: 2,
        status: 'authority_unavailable',
        code: 'authority_unavailable',
        retryable: true,
      })
      expect(site.called(query)).toHaveBeenCalled()
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        {
          event: 'workflow_checkpoint_dependency_unavailable',
          stage,
          errorName: expect.any(String),
        },
        'workflow checkpoint dependency unavailable'
      )
    }
  )

  it.each(SITES.map(site => [site.stage, site] as const))(
    '%s: a defect surfaces as itself, never as a retryable outage',
    async (_stage, site) => {
      const defect = new TypeError('defect in revalidation')
      site.fail(query, defect)

      await expect(revalidate()).rejects.toBe(defect)

      // Witness: the site's dependency ran and threw the defect.
      expect(site.called(query)).toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    }
  )

  it('stored_binding: a database error that is not an outage surfaces as itself', async () => {
    const site = SITES[0]!
    const undefinedColumn = pgError('42703')
    site.fail(query, undefinedColumn)

    await expect(revalidate()).rejects.toBe(undefinedColumn)

    expect(site.called(query)).toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('workflow run resume checkpoint revalidation: the run id', () => {
  // Hex letters, so the upper-case row differs from the canonical id.
  const runId = '4000000a-000b-4000-8000-00000000000c'
  let budget: AccessExecutionBudget
  let query: Query

  function resumeRequest(id: string) {
    return {
      ...request,
      operationId: 'workflow.run.manage',
      resource: {
        environmentId: 'development:local',
        type: 'workflow_run',
        canonicalId: `workflow_run:development:local:${id}`,
        logicalId: id,
        displayName: id,
      },
      target: { runId: id, action: 'resume' },
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    budget = AccessExecutionBudget.create('action')
    query = {
      stored: vi.fn(async () => ({
        rows: [
          {
            ...storedRow,
            binding_kind: 'run_management',
            recipe_namespace: 'sandbox-recipes',
            recipe_name: 'nightly',
          },
        ],
        rowCount: 1,
      })),
    }
    deps.authorizeActionV2.mockResolvedValue(allowed)
    deps.resolveActionDestination.mockResolvedValue({ status: 'resolved', destination: null })
  })

  afterEach(() => {
    budget.close()
  })

  function revalidate(id: string) {
    return revalidateWorkflowTriggerCheckpoint({
      request: resumeRequest(id) as never,
      caller,
      gateway: {} as never,
      budget,
      db: database(query),
    })
  }

  it('joins the run by its uuid primary key, passing the run id as the twelfth value', async () => {
    await revalidate(runId)

    expect(query.stored).toHaveBeenCalledTimes(1)
    const [text, values] = query.stored.mock.calls[0] as [string, unknown[]]
    expect(text).toContain('run.run_id = $12::uuid')
    expect(text).not.toContain('run_id::text =')
    expect(values).toHaveLength(12)
    expect(values[0]).toBe(runId)
    expect(values[11]).toBe(runId)
  })

  it.each([
    ['not a uuid', 'not-a-uuid'],
    ['upper-case', runId.toUpperCase()],
    ['braced', `{${runId}}`],
    ['unhyphenated', runId.replaceAll('-', '')],
    ['padded', ` ${runId} `],
  ])('run id %s: answers invalid_binding without sending the statement', async (_shape, id) => {
    // Liveness witness: the canonical id reaches the stored-binding statement.
    await revalidate(runId)
    expect(query.stored).toHaveBeenCalledTimes(1)
    query.stored.mockClear()

    const result = await revalidate(id)

    expect(result).toEqual({ version: 2, status: 'invalid_binding', code: 'invalid_binding' })
    expect(query.stored).not.toHaveBeenCalled()
  })
})
