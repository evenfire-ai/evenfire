import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashActionTarget } from '@clerum/action-context-contracts'
import { canonicalResourceIdentity } from '../src/services/access/resourceIdentity.js'
import {
  WORKFLOW_ACTION_DELEGATION_HEADER,
  requireWorkflowActionAuthority,
} from '../src/services/workflows/workflowAuthorityBindingService.js'

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  checkpoint: vi.fn(),
}))

vi.mock('../src/utils/auth/userDelegationV2Token.js', () => ({
  verifyUserDelegationV2: mocks.verify,
}))
vi.mock('../src/services/access/actionAuthorityCheckpoint.js', () => ({
  checkpointActionAuthority: mocks.checkpoint,
}))
vi.mock('../src/services/access/operationalAccessProjection.js', () => ({
  canonicalEnvironmentId: () => 'local',
}))

const userId = '11111111-1111-4111-8111-111111111111'
const sid = '22222222-2222-4222-8222-222222222222'
const jti = '33333333-3333-4333-8333-333333333333'
const accessPathId = `ap1_${'a'.repeat(43)}`
const authorizationRevision = `ar1_${'b'.repeat(43)}`
const behaviorBindingHash = `bh2_${'c'.repeat(43)}`
const target = Object.freeze({ recipeNamespace: 'sandbox-recipes', recipeName: 'demo' })
const resource = canonicalResourceIdentity({
  environmentId: 'local',
  type: 'workflow_recipe',
  logicalId: 'sandbox-recipes/demo',
})

function request(rawHeaders = [WORKFLOW_ACTION_DELEGATION_HEADER, 'opaque-delegation']) {
  return {
    rawHeaders,
    accessExecutionBudget: {},
    correlationId: 'corr-1',
  } as never
}

const caller = {
  kind: 'user-session',
  claims: { userId },
  session: { contract: 'v2', userId, sid, sessionVersion: 4 },
} as const

function validClaims() {
  return {
    typ: 'user_delegation',
    ver: 2,
    sub: userId,
    sid,
    sv: 4,
    jti,
    iat: 1_700_000_000,
    exp: 1_700_000_300,
    operationIds: ['workflow.trigger'],
    scopes: ['workflow.trigger'],
    resource,
    targets: { 'workflow.trigger': target },
    targetHashes: { 'workflow.trigger': hashActionTarget(target) },
    accessPathId,
    authorizationRevision,
    behaviorBindingHash,
    pathKind: 'direct',
    effectiveTeamId: null,
  }
}

function allowedCheckpoint() {
  return {
    version: 2,
    status: 'allowed',
    authorizationRevision,
    behaviorBindingHash,
    behavior: {
      budget: { state: 'known', value: null },
      credentialPolicy: { state: 'known', value: null },
      approvalPolicy: { state: 'known', value: null },
      filesystemScope: { state: 'known', value: null },
      runtime: { state: 'known', value: null },
      providerModelPolicy: { state: 'known', value: null },
      audit: { state: 'known', value: `user:${userId}` },
    },
    checkedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 30_000).toISOString(),
    attribution: {
      userId,
      sid,
      sessionVersion: 4,
      accessPathId,
      pathKind: 'direct',
      effectiveTeamId: null,
    },
    destination: null,
  }
}

describe('workflow authority binding ingress', () => {
  beforeEach(() => {
    mocks.verify.mockReset().mockReturnValue(validClaims())
    mocks.checkpoint.mockReset().mockResolvedValue(allowedCheckpoint())
  })

  it('rejects an allowed checkpoint attributed to different live authority', async () => {
    mocks.checkpoint.mockResolvedValueOnce({
      ...allowedCheckpoint(),
      attribution: {
        ...allowedCheckpoint().attribution,
        accessPathId: `ap1_${'d'.repeat(43)}`,
      },
    })

    await expect(
      requireWorkflowActionAuthority({
        req: request(),
        caller: caller as never,
        operationId: 'workflow.trigger',
        resourceType: 'workflow_recipe',
        resourceLogicalId: 'sandbox-recipes/demo',
        target,
        gateway: {} as never,
      })
    ).rejects.toMatchObject({ status: 400, code: 'invalid_action_delegation' })
  })

  it('verifies exact user/session/operation/target authority and checkpoints it live', async () => {
    const authority = await requireWorkflowActionAuthority({
      req: request(),
      caller: caller as never,
      operationId: 'workflow.trigger',
      resourceType: 'workflow_recipe',
      resourceLogicalId: 'sandbox-recipes/demo',
      target,
      gateway: {} as never,
    })

    expect(mocks.verify).toHaveBeenCalledWith('opaque-delegation')
    expect(mocks.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          principal: { sub: userId, sid, sessionVersion: 4 },
          delegationJti: jti,
          operationId: 'workflow.trigger',
          target,
        }),
      })
    )
    expect(authority?.binding).toMatchObject({
      userId,
      sid,
      delegationJti: jti,
      operationId: 'workflow.trigger',
      target,
    })
  })

  it('fails closed for missing, duplicate, wrong-operation, and denied authority', async () => {
    await expect(
      requireWorkflowActionAuthority({
        req: request([]),
        caller: caller as never,
        operationId: 'workflow.trigger',
        resourceType: 'workflow_recipe',
        resourceLogicalId: 'sandbox-recipes/demo',
        target,
        gateway: {} as never,
      })
    ).rejects.toMatchObject({ status: 400, code: 'invalid_action_delegation' })

    await expect(
      requireWorkflowActionAuthority({
        req: request([
          WORKFLOW_ACTION_DELEGATION_HEADER,
          'one',
          WORKFLOW_ACTION_DELEGATION_HEADER,
          'two',
        ]),
        caller: caller as never,
        operationId: 'workflow.trigger',
        resourceType: 'workflow_recipe',
        resourceLogicalId: 'sandbox-recipes/demo',
        target,
        gateway: {} as never,
      })
    ).rejects.toMatchObject({ status: 400 })

    mocks.verify.mockReturnValueOnce({ ...validClaims(), operationIds: ['workflow.read'] })
    await expect(
      requireWorkflowActionAuthority({
        req: request(),
        caller: caller as never,
        operationId: 'workflow.trigger',
        resourceType: 'workflow_recipe',
        resourceLogicalId: 'sandbox-recipes/demo',
        target,
        gateway: {} as never,
      })
    ).rejects.toMatchObject({ status: 400 })

    mocks.checkpoint.mockResolvedValueOnce({ status: 'denied' })
    await expect(
      requireWorkflowActionAuthority({
        req: request(),
        caller: caller as never,
        operationId: 'workflow.trigger',
        resourceType: 'workflow_recipe',
        resourceLogicalId: 'sandbox-recipes/demo',
        target,
        gateway: {} as never,
      })
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  })

  it('preserves explicit legacy requests and rejects v2 credential injection', async () => {
    const legacyCaller = { ...caller, session: { ...caller.session, contract: 'v1' } }
    await expect(
      requireWorkflowActionAuthority({
        req: request([]),
        caller: legacyCaller as never,
        operationId: 'workflow.trigger',
        resourceType: 'workflow_recipe',
        resourceLogicalId: 'sandbox-recipes/demo',
        target,
        gateway: {} as never,
      })
    ).resolves.toBeNull()
    await expect(
      requireWorkflowActionAuthority({
        req: request(),
        caller: legacyCaller as never,
        operationId: 'workflow.trigger',
        resourceType: 'workflow_recipe',
        resourceLogicalId: 'sandbox-recipes/demo',
        target,
        gateway: {} as never,
      })
    ).rejects.toMatchObject({ status: 400 })
  })
})
