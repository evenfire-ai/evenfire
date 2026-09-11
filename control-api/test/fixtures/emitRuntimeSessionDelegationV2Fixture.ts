import type { ActionOperationId } from '@clerum/action-context-contracts'
import { prepareActionOperationTarget } from '../../src/services/access/actionMessageId.js'
import { canonicalResourceIdentity } from '../../src/services/access/resourceIdentity.js'
import { issueUserDelegationV2 } from '../../src/utils/auth/userDelegationV2Token.js'

const operationId = process.argv[2] as ActionOperationId
const targets: Partial<Record<ActionOperationId, Readonly<Record<string, string>>>> = {
  'session.read': { hostRef: 'mcp-host/chatllm' },
  'task.read': { hostRef: 'mcp-host/chatllm', taskId: 'task-a' },
  'task.manage': { hostRef: 'mcp-host/chatllm', taskId: 'task-a', action: 'cancel' },
  'model.read': { hostRef: 'mcp-host/chatllm', agent: 'agent-a', chatId: 'chat-a' },
  'model.select': {
    hostRef: 'mcp-host/chatllm',
    agent: 'agent-a',
    chatId: 'chat-a',
    provider: 'openai',
    model: 'model-a',
  },
}
const operationTarget = targets[operationId]
if (!operationTarget) throw new Error('runtime_session_operation_required')

const resource = canonicalResourceIdentity({
  environmentId: 'development:local',
  type: 'runtime_session',
  logicalId: 'session-a',
})
const prepared = prepareActionOperationTarget({
  operationId,
  resource,
  operationTarget,
  allocateMessageId: () => {
    throw new Error('runtime_session_operation_must_not_allocate_message_id')
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

process.stdout.write(JSON.stringify({ operationId, token }))
