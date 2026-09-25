import type { ActionOperationId } from '@clerum/action-context-contracts'
import { knownBehavior } from '../../src/services/access/accessPath.js'
import { authorizeActionV2 } from '../../src/services/access/actionAuthorizer.js'
import { canonicalResourceIdentity } from '../../src/services/access/resourceIdentity.js'
import { issueUserDelegationV2 } from '../../src/utils/auth/userDelegationV2Token.js'

async function main(): Promise<void> {
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
  const accessPathId = `ap1_${'a'.repeat(43)}`
  const authorizationRevision = `ar1_${'b'.repeat(43)}`
  const known = knownBehavior(null)
  const authorization = await authorizeActionV2(
    {
      session: {
        contract: 'v2',
        userId: '10000000-0000-4000-8000-000000000001',
        sid: '20000000-0000-4000-8000-000000000002',
        jti: '30000000-0000-4000-8000-000000000003',
        sessionVersion: 1,
      },
      requested: { version: 2, requestedAccessPathId: accessPathId },
      operationId,
      resource,
      operationTarget,
      allocateChatMessageId: false,
    },
    {
      resolve: async input => {
        if (input.resource.type !== 'host' || input.resource.logicalId !== 'mcp-host/chatllm') {
          throw new Error('runtime_session_authority_must_resolve_through_host')
        }
        return {
          status: 'allowed',
          effectiveCapabilities: [operationId],
          paths: [],
          selectedPath: {
            id: accessPathId,
            kind: 'direct',
            grantId: '40000000-0000-4000-8000-000000000004',
            authorizationRevision,
            behavior: {
              capabilities: [operationId],
              budget: known,
              credentialPolicy: known,
              approvalPolicy: known,
              filesystemScope: known,
              runtime: known,
              providerModelPolicy: known,
              audit: known,
            },
          },
          authorizationRevision,
          validUntil: null,
        }
      },
    }
  )
  if (authorization.status !== 'allowed') throw new Error(`authorization_${authorization.status}`)
  const token = issueUserDelegationV2({
    principal: {
      userId: '10000000-0000-4000-8000-000000000001',
      sid: '20000000-0000-4000-8000-000000000002',
      sessionVersion: 1,
    },
    operationIds: [operationId],
    resource,
    preparedTargets: { [operationId]: authorization.preparedTarget },
    accessPathId: authorization.context.accessPathId,
    authorizationRevision: authorization.context.authorizationRevision,
    behaviorBindingHash: authorization.context.behaviorBindingHash,
    pathKind: authorization.context.pathKind,
    effectiveTeamId: authorization.context.effectiveTeamId,
  })

  process.stdout.write(JSON.stringify({ operationId, token }))
}

void main()
