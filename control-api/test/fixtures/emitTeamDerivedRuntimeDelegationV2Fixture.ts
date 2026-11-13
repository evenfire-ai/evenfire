import { actionBehaviorBindingHash } from '@clerum/action-context-contracts'
import { buildAccessPath, knownBehavior } from '../../src/services/access/accessPath.js'
import { prepareActionOperationTarget } from '../../src/services/access/actionMessageId.js'
import { canonicalEnvironmentId } from '../../src/services/access/operationalAccessProjection.js'
import { canonicalResourceIdentity } from '../../src/services/access/resourceIdentity.js'
import { issueUserDelegationV2 } from '../../src/utils/auth/userDelegationV2Token.js'

const userId = '10000000-0000-4000-8000-000000000001'
const teamId = '20000000-0000-4000-8000-000000000002'
const sid = '30000000-0000-4000-8000-000000000003'
const resource = canonicalResourceIdentity({
  environmentId: canonicalEnvironmentId(),
  type: 'host',
  logicalId: 'mcp-host/chatllm',
})
const behavior = Object.freeze({
  capabilities: Object.freeze(['host.read'] as const),
  budget: knownBehavior(null),
  credentialPolicy: knownBehavior(null),
  approvalPolicy: knownBehavior(null),
  filesystemScope: knownBehavior(null),
  runtime: knownBehavior(null),
  providerModelPolicy: knownBehavior(null),
  audit: knownBehavior(`user:${userId}`),
})
const path = buildAccessPath({
  principalUserId: userId,
  resource,
  seed: {
    kind: 'team',
    grantId: `team_agents:${teamId}:chatllm`,
    teamId,
    currentRole: 'member',
    behavior,
  },
  authorizationRevision: `ar1_${'b'.repeat(43)}`,
})
const prepared = prepareActionOperationTarget({
  operationId: 'host.status.read',
  resource,
  operationTarget: { hostRef: 'mcp-host/chatllm' },
})
const behaviorBindingHash = actionBehaviorBindingHash({
  accessPathId: path.id,
  authorizationRevision: path.authorizationRevision,
  behavior,
})
const token = issueUserDelegationV2({
  principal: { userId, sid, sessionVersion: 1 },
  operationIds: ['host.status.read'],
  resource,
  preparedTargets: { 'host.status.read': prepared },
  accessPathId: path.id,
  authorizationRevision: path.authorizationRevision,
  behaviorBindingHash,
  pathKind: path.kind,
  effectiveTeamId: path.teamId ?? null,
})

process.stdout.write(JSON.stringify({ token, userId, teamId, sid, accessPathId: path.id }))
