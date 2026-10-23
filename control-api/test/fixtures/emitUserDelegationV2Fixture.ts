import { prepareActionOperationTarget } from '../../src/services/access/actionMessageId.js'
import { canonicalResourceIdentity } from '../../src/services/access/resourceIdentity.js'
import { issueUserDelegationV2 } from '../../src/utils/auth/userDelegationV2Token.js'

const resource = canonicalResourceIdentity({
  environmentId: 'development:local',
  type: 'host',
  logicalId: 'mcp-host/chatllm',
})
const prepared = prepareActionOperationTarget({
  operationId: 'host.wake',
  resource,
  operationTarget: { hostRef: 'mcp-host/chatllm', wakeReason: 'explicit' },
  allocateMessageId: () => {
    throw new Error('host.wake must not allocate a message ID')
  },
})
const token = issueUserDelegationV2({
  principal: {
    userId: '10000000-0000-4000-8000-000000000001',
    sid: '20000000-0000-4000-8000-000000000002',
    sessionVersion: 1,
  },
  operationIds: ['host.wake'],
  resource,
  preparedTargets: { 'host.wake': prepared },
  accessPathId: `ap1_${'a'.repeat(43)}`,
  authorizationRevision: `ar1_${'b'.repeat(43)}`,
  behaviorBindingHash: `bh2_${'c'.repeat(43)}`,
  pathKind: 'direct',
  effectiveTeamId: null,
})

process.stdout.write(JSON.stringify({ token }))
