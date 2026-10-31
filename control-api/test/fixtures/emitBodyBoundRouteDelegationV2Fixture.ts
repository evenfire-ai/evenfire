import type { ActionOperationId } from '@clerum/action-context-contracts'
import { prepareActionOperationTarget } from '../../src/services/access/actionMessageId.js'
import { canonicalResourceIdentity } from '../../src/services/access/resourceIdentity.js'
import { issueUserDelegationV2 } from '../../src/utils/auth/userDelegationV2Token.js'

type Input = {
  operationId: ActionOperationId
  resourceType: 'host' | 'mcp_server' | 'runtime_session' | 'sandbox_app'
  resourceId: string
  target: Record<string, string>
}

const input = JSON.parse(process.argv[2] ?? '') as Input
const resource = canonicalResourceIdentity({
  environmentId: 'development:local',
  type: input.resourceType,
  logicalId: input.resourceId,
})
const prepared = prepareActionOperationTarget({
  operationId: input.operationId,
  resource,
  operationTarget: input.target,
  allocateMessageId: () => '50000000-0000-4000-8000-000000000005',
})
const token = issueUserDelegationV2({
  principal: {
    userId: '10000000-0000-4000-8000-000000000001',
    sid: '20000000-0000-4000-8000-000000000002',
    sessionVersion: 1,
  },
  operationIds: [input.operationId],
  resource,
  preparedTargets: { [input.operationId]: prepared },
  accessPathId: `ap1_${'a'.repeat(43)}`,
  authorizationRevision: `ar1_${'b'.repeat(43)}`,
  behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
  pathKind: 'direct',
  effectiveTeamId: null,
})

process.stdout.write(
  JSON.stringify({ token, operationId: input.operationId, messageId: prepared.messageId ?? null })
)
