import { describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
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
import { stableStringify } from '../src/utils/stableStringify.js'

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
const membershipRows: unknown[] = []
const resourceRevisionRows = [{ revision: 1 }]
const sourceStateRows = [
  { generation: 1, resource_version: 'rv1', status: 'current', safe_error_code: null },
]
const resourceRows = [
  {
    source_generation: 1,
    provider_uid: 'provider-1',
    provider_resource_version: 'rv1',
    enabled: true,
    deleted_at: null,
  },
]
const relationshipRows: unknown[] = []
const grantRows = [{ user_id: userId, recipe_namespace: recipeNamespace, recipe_name: recipeName }]

function expectedFingerprint(): string {
  return createHash('sha256')
    .update(
      stableStringify({
        session: sessionRows,
        memberships: membershipRows,
        resourceRevision: resourceRevisionRows,
        sourceState: sourceStateRows,
        resource: resourceRows,
        relationships: relationshipRows,
        grant: grantRows,
      })
    )
    .digest('hex')
}

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
      if (sql.includes('SELECT tm.team_id')) {
        queryOrder.push('memberships')
        return response(membershipRows)
      }
      if (sql.includes('SELECT revision')) {
        queryOrder.push('resource-revision')
        return response(resourceRevisionRows)
      }
      if (sql.includes('SELECT generation, resource_version')) {
        queryOrder.push('source-state')
        return response(sourceStateRows)
      }
      if (sql.includes('SELECT source_generation')) {
        queryOrder.push('resource')
        return response(resourceRows)
      }
      if (sql.includes('SELECT source_type')) {
        queryOrder.push('relationships')
        return response(relationshipRows)
      }
      if (sql.includes('SELECT user_id, recipe_namespace')) {
        queryOrder.push('grant')
        return response(grantRows)
      }
      throw new Error(`Unexpected workflow authority query: ${sql}`)
    },
  }
  return { db: db as unknown as DbClient, queryOrder }
}

describe('workflow trigger final expiry fence', () => {
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
    await expect(
      requireCurrentWorkflowTriggerAuthority({
        db,
        authority,
        expectedFence: { fingerprint: expectedFingerprint() },
      })
    ).rejects.toMatchObject({ status: 409, code: 'access_path_stale' })
    expect(queryOrder.at(-1)).toBe('final-expiry-check')
    expect(queryOrder.indexOf('final-expiry-check')).toBeGreaterThan(queryOrder.indexOf('grant'))
  })

  it('preserves a matching, current authority', async () => {
    const authority = await createAuthority()
    const { db, queryOrder } = expiryDb({
      delegationCurrentAtFinalFence: true,
      idleSessionCurrentAtFinalFence: true,
      absoluteSessionCurrentAtFinalFence: true,
    })
    await expect(
      requireCurrentWorkflowTriggerAuthority({
        db,
        authority,
        expectedFence: { fingerprint: expectedFingerprint() },
      })
    ).resolves.toBe(authority)
    expect(queryOrder.at(-1)).toBe('final-expiry-check')
  })
})
