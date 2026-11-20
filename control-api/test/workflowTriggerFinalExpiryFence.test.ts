import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { DbClient } from '../src/db.js'
import { prepareActionOperationTarget } from '../src/services/access/actionMessageId.js'
import { canonicalEnvironmentId } from '../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import {
  requireCurrentWorkflowTriggerAuthority,
  workflowAuthorityBindingFromClaims,
} from '../src/services/workflows/workflowAuthorityBindingService.js'
import {
  issueUserDelegationV2,
  verifyUserDelegationV2,
} from '../src/utils/auth/userDelegationV2Token.js'

const userId = randomUUID()
const sid = randomUUID()
const recipeNamespace = 'sandbox-recipes'
const recipeName = 'expiry-fence'
const idleExpiresAt = new Date(Date.now() + 60_000).toISOString()
const absoluteExpiresAt = new Date(Date.now() + 120_000).toISOString()

const sessionRows = [
  {
    lifecycle_state: 'active',
    session_version: 1,
    current_jti: randomUUID(),
    revoked_at: null,
    idle_expires_at: idleExpiresAt,
    absolute_expires_at: absoluteExpiresAt,
  },
]
const grantRows = [{ user_id: userId, recipe_namespace: recipeNamespace, recipe_name: recipeName }]

async function createAuthority() {
  const resource = canonicalResourceIdentity({
    environmentId: canonicalEnvironmentId(),
    type: 'workflow_recipe',
    logicalId: `${recipeNamespace}/${recipeName}`,
  })
  const target = Object.freeze({ recipeNamespace, recipeName })
  const prepared = prepareActionOperationTarget({
    operationId: 'workflow.trigger',
    resource,
    operationTarget: target,
  })
  const token = issueUserDelegationV2({
    principal: { userId, sid, sessionVersion: 1 },
    operationIds: ['workflow.trigger'],
    resource,
    preparedTargets: { 'workflow.trigger': prepared },
    accessPathId: `ap1_${'a'.repeat(43)}`,
    authorizationRevision: `ar1_${'b'.repeat(43)}`,
    behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
    pathKind: 'direct',
    effectiveTeamId: null,
    ttlSeconds: 300,
  })
  const claims = verifyUserDelegationV2(token)
  if (!claims) throw new Error('real delegation producer failed to verify test authority')
  return workflowAuthorityBindingFromClaims(claims)
}

function expiryDb(input: {
  delegationCurrentAtFinalFence: boolean
  idleSessionCurrentAtFinalFence: boolean
  absoluteSessionCurrentAtFinalFence: boolean
}): { db: DbClient; queryOrder: string[] } {
  const queryOrder: string[] = []
  const response = (rows: unknown[]) => ({ rows, rowCount: rows.length })
  const db = {
    async query(sql: string) {
      if (sql.includes('idleSessionCurrent')) {
        queryOrder.push('final-expiry-check')
        return response([
          {
            delegationCurrent: input.delegationCurrentAtFinalFence,
            idleSessionCurrent: input.idleSessionCurrentAtFinalFence,
            absoluteSessionCurrent: input.absoluteSessionCurrentAtFinalFence,
          },
        ])
      }
      if (sql.includes('SELECT u.lifecycle_state')) {
        queryOrder.push('session')
        return response(sessionRows)
      }
      if (sql.includes('SELECT user_id, recipe_namespace')) {
        queryOrder.push('grant')
        return response(grantRows)
      }
      // The row check reads only the bound session and grant rows; any other
      // statement (a revision counter or an index table) fails the test.
      throw new Error(`Unexpected workflow authority query: ${sql}`)
    },
  }
  return { db: db as unknown as DbClient, queryOrder }
}

describe('workflow trigger row check final expiry', () => {
  it.each([
    {
      field: 'delegation',
      delegationCurrentAtFinalFence: false,
      idleSessionCurrentAtFinalFence: true,
      absoluteSessionCurrentAtFinalFence: true,
    },
    {
      field: 'idle session',
      delegationCurrentAtFinalFence: true,
      idleSessionCurrentAtFinalFence: false,
      absoluteSessionCurrentAtFinalFence: true,
    },
    {
      field: 'absolute session',
      delegationCurrentAtFinalFence: true,
      idleSessionCurrentAtFinalFence: true,
      absoluteSessionCurrentAtFinalFence: false,
    },
  ])('rejects $field expiry observed after final authority reads', async status => {
    const authority = await createAuthority()
    const { db, queryOrder } = expiryDb(status)
    await expect(requireCurrentWorkflowTriggerAuthority({ db, authority })).rejects.toMatchObject({
      status: 409,
      code: 'access_path_stale',
    })
    expect(queryOrder).toEqual(['session', 'grant', 'final-expiry-check'])
  })

  it('preserves a matching, current authority', async () => {
    const authority = await createAuthority()
    const { db, queryOrder } = expiryDb({
      delegationCurrentAtFinalFence: true,
      idleSessionCurrentAtFinalFence: true,
      absoluteSessionCurrentAtFinalFence: true,
    })
    await expect(requireCurrentWorkflowTriggerAuthority({ db, authority })).resolves.toBe(authority)
    expect(queryOrder).toEqual(['session', 'grant', 'final-expiry-check'])
  })
})
