import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const workflowRecipes = { service: 'workflow-recipes', trustPlane: 'internal_control_jwt' } as const
const storedRow = { binding_kind: 'trigger', path_kind: 'direct', effective_team_id: null }
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

/** Stages that remain after the stored expiry re-read was removed. */
const REMAINING_STAGES = [
  'stored_binding',
  'path_resolution',
  'selected_path_resolution',
  'destination',
] as const

describe('workflow continuation checkpoint stages', () => {
  let budget: AccessExecutionBudget
  let stored: ReturnType<typeof vi.fn>
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    budget = AccessExecutionBudget.create('action')
    stored = vi.fn(async () => ({ rows: [storedRow], rowCount: 1 }))
    deps.authorizeActionV2.mockResolvedValue(allowed)
    deps.resolveActionDestination.mockResolvedValue({ status: 'resolved', destination: null })
    warn = vi.spyOn(rootLogger, 'warn').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    warn.mockRestore()
    budget.close()
  })

  function revalidate(caller: { service: string; trustPlane: string } = workflowRecipes) {
    return revalidateWorkflowTriggerCheckpoint({
      request: request as never,
      caller: caller as never,
      gateway: {} as never,
      budget,
      db: { query: (text: string, values: unknown[]) => stored(text, values) },
    })
  }

  /** Make the dependency of `stage` fail with a retryable outage. */
  function failStage(stage: (typeof REMAINING_STAGES)[number]) {
    if (stage === 'stored_binding') {
      stored.mockRejectedValue(new Error('timeout exceeded when trying to connect'))
    } else if (stage === 'path_resolution') {
      deps.authorizeActionV2.mockRejectedValueOnce(new AccessExecutionCancelledError('deadline'))
    } else if (stage === 'selected_path_resolution') {
      deps.authorizeActionV2.mockResolvedValueOnce({
        status: 'access_path_required',
        paths: [{ id: accessPathId, kind: 'direct' }],
      })
      deps.authorizeActionV2.mockRejectedValueOnce(new AccessExecutionCancelledError('deadline'))
    } else {
      deps.resolveActionDestination.mockRejectedValue(
        new AccessExecutionCancelledError('cancelled')
      )
    }
  }

  it('a dependency failure at each remaining stage is authority_unavailable; a terminal run or foreign caller is invalid_binding', async () => {
    // Allowed checkpoint: the stored-binding statement is the only statement
    // revalidation sends (the base sent a second one, the expiry re-read).
    await expect(revalidate()).resolves.toMatchObject({ status: 'allowed' })
    expect(stored).toHaveBeenCalledTimes(1)
    const [storedText] = stored.mock.calls[0] as [string, unknown[]]
    expect(storedText).not.toContain('source_expires_at')
    expect(deps.authorizeActionV2).toHaveBeenCalledTimes(1)
    expect(deps.resolveActionDestination).toHaveBeenCalledTimes(1)

    // Each remaining stage: a dependency outage is the retryable answer,
    // logged with that stage.
    const loggedStages: string[] = []
    for (const stage of REMAINING_STAGES) {
      vi.clearAllMocks()
      stored.mockReset()
      stored.mockResolvedValue({ rows: [storedRow], rowCount: 1 })
      deps.authorizeActionV2.mockResolvedValue(allowed)
      deps.resolveActionDestination.mockResolvedValue({ status: 'resolved', destination: null })
      failStage(stage)

      await expect(revalidate()).resolves.toEqual({
        version: 2,
        status: 'authority_unavailable',
        code: 'authority_unavailable',
        retryable: true,
      })
      expect(warn).toHaveBeenCalledTimes(1)
      loggedStages.push((warn.mock.calls[0]![0] as { stage: string }).stage)
    }
    expect(loggedStages).toEqual([...REMAINING_STAGES])

    // A terminal run: the stored statement only matches a run in a
    // non-terminal phase, so it returns no row and the answer is
    // invalid_binding before any live resolution.
    vi.clearAllMocks()
    stored.mockReset()
    stored.mockResolvedValue({ rows: [], rowCount: 0 })
    await expect(revalidate()).resolves.toEqual({
      version: 2,
      status: 'invalid_binding',
      code: 'invalid_binding',
    })
    expect(stored).toHaveBeenCalledTimes(1)
    expect(stored.mock.calls[0]![0]).toContain(
      "run.phase IN ('Pending', 'Running', 'AuthorizationPaused')"
    )
    expect(deps.authorizeActionV2).not.toHaveBeenCalled()

    // A caller other than workflow-recipes on the internal plane: refused
    // before any statement. Witness: the same request from workflow-recipes
    // reached the statement just above.
    stored.mockClear()
    await expect(
      revalidate({ service: 'mcp-host', trustPlane: 'internal_control_jwt' })
    ).resolves.toEqual({
      version: 2,
      status: 'invalid_binding',
      code: 'invalid_binding',
    })
    expect(stored).not.toHaveBeenCalled()
  })
})
