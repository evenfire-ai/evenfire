import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { canonicalResourceIdentity, hashActionTarget } from '@clerum/action-context-contracts'
import { createWorkflowRunAuthorityCheckpointer } from './workflowActionCheckpointClient'

vi.mock('../utils/internalControlSigner', () => ({
  signInternalControlJwt: () => 'v2-token',
}))

const userId = '11111111-1111-4111-8111-111111111111'
const sid = '22222222-2222-4222-8222-222222222222'
const accessPathId = `ap1_${'a'.repeat(43)}`
const authorizationRevision = `ar1_${'b'.repeat(43)}`
const behaviorBindingHash = `bh2_${'c'.repeat(43)}`
const target = { recipeNamespace: 'sandbox-recipes', recipeName: 'demo' }
const resource = canonicalResourceIdentity({
  environmentId: 'local',
  type: 'workflow_recipe',
  logicalId: 'sandbox-recipes/demo',
})

const run = {
  authority_binding: {
    version: 2,
    userId,
    sid,
    sessionVersion: 3,
    delegationJti: '33333333-3333-4333-8333-333333333333',
    operationId: 'workflow.trigger',
    resource,
    target,
    targetHash: hashActionTarget(target),
    accessPathId,
    authorizationRevision,
    pathKind: 'direct',
    effectiveTeamId: null,
    behaviorBindingHash,
  },
} as never

function allowedCheckpoint(overrides: Record<string, unknown> = {}) {
  const repositoryRoot = resolve(process.cwd(), '..')
  const output = execFileSync(
    resolve(repositoryRoot, 'rpc-proxy/node_modules/.bin/tsx'),
    [
      resolve(
        repositoryRoot,
        'control-api/test/fixtures/emitActionAuthorityCheckpointV2Fixture.ts'
      ),
      JSON.stringify({
        request: {
          version: 2,
          principal: { sub: userId, sid, sessionVersion: 3 },
          delegationJti: run.authority_binding.delegationJti,
          resource,
          operationId: 'workflow.trigger',
          target,
          targetHash: hashActionTarget(target),
          accessPathId,
          authorizationRevision,
          behaviorBindingHash,
          domain: { service: 'workflow-recipes', resource, targetHash: hashActionTarget(target) },
        },
        destination: null,
        checkedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 30_000).toISOString(),
      }),
    ],
    { cwd: repositoryRoot, encoding: 'utf8' }
  )
  return { ...JSON.parse(output), ...overrides }
}

describe('workflow action checkpoint client', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('uses the WRC service credential and exact persisted trigger binding', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        'content-type': 'application/json',
        authorization: 'Bearer v2-token',
      })
      expect(JSON.parse(String(init?.body))).toMatchObject({
        operationId: 'workflow.trigger',
        delegationJti: '33333333-3333-4333-8333-333333333333',
        domain: { service: 'workflow-recipes', targetHash: hashActionTarget(target) },
      })
      return new Response(JSON.stringify(allowedCheckpoint()), { status: 200 })
    })
    const checkpoint = createWorkflowRunAuthorityCheckpointer({
      baseUrl: 'http://control-api:8090',
      fetchImpl: fetchImpl as typeof fetch,
    })

    await expect(checkpoint(run)).resolves.toBeUndefined()
  })

  it('fails closed on checkpoint denial and malformed success bodies', async () => {
    const denied = createWorkflowRunAuthorityCheckpointer({
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ version: 2, status: 'denied', code: 'forbidden' }), {
            status: 403,
          })
      ) as typeof fetch,
    })
    await expect(denied(run)).rejects.toThrow('workflow_authority_denied')

    const malformed = createWorkflowRunAuthorityCheckpointer({
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify({ version: 2, status: 'allowed' }), { status: 200 })
      ) as typeof fetch,
    })
    await expect(malformed(run)).rejects.toThrow('workflow_authority_checkpoint_invalid_response')
  })

  it('rejects an allowed response attributed to a different binding', async () => {
    const checkpoint = createWorkflowRunAuthorityCheckpointer({
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              allowedCheckpoint({
                attribution: {
                  ...allowedCheckpoint().attribution,
                  accessPathId: `ap1_${'d'.repeat(43)}`,
                },
              })
            ),
            { status: 200 }
          )
      ) as typeof fetch,
    })

    await expect(checkpoint(run)).rejects.toThrow('workflow_authority_denied')
  })

  it('rejects expired or status-mismatched checkpoint responses', async () => {
    const expired = createWorkflowRunAuthorityCheckpointer({
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              allowedCheckpoint({
                checkedAt: '2026-01-01T00:00:00.000Z',
                validUntil: '2026-01-01T00:00:01.000Z',
              })
            ),
            { status: 200 }
          )
      ) as typeof fetch,
    })
    await expect(expired(run)).rejects.toThrow('workflow_authority_denied')

    const mismatchedStatus = createWorkflowRunAuthorityCheckpointer({
      fetchImpl: vi.fn(
        async () => new Response(JSON.stringify(allowedCheckpoint()), { status: 403 })
      ) as typeof fetch,
    })
    await expect(mismatchedStatus(run)).rejects.toThrow(
      'workflow_authority_checkpoint_invalid_response'
    )
  })
})
