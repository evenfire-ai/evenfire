import { describe, expect, it, vi } from 'vitest'
import { loadResourceAuthority } from '../src/services/access/accessAuthorityStore.js'
import { AccessExecutionBudget } from '../src/services/access/accessExecutionBudget.js'
import { validateActionOperationTarget } from '../src/services/access/actionOperationRegistry.js'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'

const userId = '11111111-1111-4111-8111-111111111111'
const runId = '22222222-2222-4222-8222-222222222222'
const artifactName = 'report.json'
const resource = canonicalResourceIdentity({
  environmentId: 'local',
  type: 'workflow_artifact',
  logicalId: `${runId}/${artifactName}`,
})

describe('workflow artifact authority producer', () => {
  it('derives exact artifact capability from the authoritative run grant', async () => {
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      expect(sql).toContain("$2::text = 'workflow_artifact'")
      expect(sql).toContain("wr.run_id::text = split_part($3, '/', 1)")
      expect(values.slice(0, 3)).toEqual([userId, 'workflow_artifact', `${runId}/${artifactName}`])
      return {
        rows: [
          {
            kind: 'direct',
            grant_id: `workflow_artifacts:user:${runId}:${runId}/${artifactName}`,
            team_id: null,
            current_role: null,
            permissions: null,
            recipe_namespace: 'sandbox-recipes',
            recipe_name: 'demo',
            valid_until: null,
            related_team: null,
            usage_team: null,
            drive: null,
            parent_resource: null,
          },
        ],
        rowCount: 1,
      }
    })
    const budget = AccessExecutionBudget.create('action')
    try {
      const result = await loadResourceAuthority({
        db: { query } as never,
        budget,
        snapshot: {
          userId,
          sessionContract: 'v2',
          sessionLive: true,
          sessionRevision: 'session-revision',
          userRevision: 'user-revision',
          resourceRevision: 'resource-revision',
          memberships: [],
        },
        resource,
        operationTarget: validateActionOperationTarget({
          operationId: 'workflow.artifact.read',
          resource,
          operationTarget: { runId, artifactName },
        } as never),
        operationalGraph: null,
      })

      expect(result.exists).toBe(true)
      expect(result.candidates).toHaveLength(1)
      expect(result.candidates[0]?.behavior.capabilities).toEqual([
        'workflow.artifact.delete',
        'workflow.artifact.read',
      ])
      expect(result.relationships).toEqual([
        { type: 'recipe', targetResourceId: 'workflow_recipe:sandbox-recipes/demo' },
      ])
    } finally {
      budget.close()
    }
  })
})
