import { prepareActionOperationTarget } from '../../src/services/access/actionMessageId.js'
import { canonicalResourceIdentity } from '../../src/services/access/resourceIdentity.js'
import { issueUserDelegationV2 } from '../../src/utils/auth/userDelegationV2Token.js'

const operationId = process.argv[2]
if (operationId !== 'sandbox.oauth.vend' && operationId !== 'sandbox.oauth.disconnect') {
  throw new Error('sandbox_oauth_operation_required')
}

const resource = canonicalResourceIdentity({
  environmentId: 'development:local',
  type: 'sandbox_app',
  logicalId: 'sandbox-recipes/r1',
})
const prepared = prepareActionOperationTarget({
  operationId,
  resource,
  operationTarget: {
    recipeNamespace: 'sandbox-recipes',
    recipeName: 'r1',
    oauthClientId: 'google-calendar',
  },
  allocateMessageId: () => {
    throw new Error('sandbox_oauth_operation_must_not_allocate_message_id')
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

process.stdout.write(JSON.stringify({ token, operationId }))
