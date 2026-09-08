import { prepareActionOperationTarget } from '../../src/services/access/actionMessageId.js'
import { canonicalResourceIdentity } from '../../src/services/access/resourceIdentity.js'
import { issueUserDelegationV2 } from '../../src/utils/auth/userDelegationV2Token.js'

const operationId = process.argv[2]
if (
  operationId !== 'sandbox.open' &&
  operationId !== 'sandbox.reconnect' &&
  operationId !== 'remote_desktop.open' &&
  operationId !== 'remote_desktop.reconnect'
) {
  throw new Error('derived_view_operation_required')
}

const sandbox = operationId.startsWith('sandbox.')
const resource = canonicalResourceIdentity({
  environmentId: 'development:local',
  type: sandbox ? 'sandbox_app' : 'host',
  logicalId: sandbox ? 'sandbox-recipes/r1' : 'mcp-host/chatllm',
})
const operationTarget = sandbox
  ? { recipeNamespace: 'sandbox-recipes', recipeName: 'r1' }
  : { hostRef: 'mcp-host/chatllm' }
const prepared = prepareActionOperationTarget({
  operationId,
  resource,
  operationTarget,
  allocateMessageId: () => {
    throw new Error('derived_view_operation_must_not_allocate_message_id')
  },
})
const token = issueUserDelegationV2({
  principal: {
    userId: '10000000-0000-4000-8000-000000000001',
    sid: '20000000-0000-4000-8000-000000000002',
    sessionVersion: 1,
  },
  operationIds: [operationId],
  resource,
  preparedTargets: { [operationId]: prepared },
  accessPathId: `ap1_${'a'.repeat(43)}`,
  authorizationRevision: `ar1_${'b'.repeat(43)}`,
  behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
  pathKind: 'direct',
  effectiveTeamId: null,
})

process.stdout.write(JSON.stringify({ token }))
