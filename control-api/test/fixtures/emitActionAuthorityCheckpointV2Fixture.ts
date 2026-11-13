import { installControlApiJwtTestKeys } from '../../../scripts/testing/controlApiJwtTestKeys.js'
import type { checkpointActionAuthority as checkpointActionAuthorityFn } from '../../src/services/access/actionAuthorityCheckpoint.js'

type FixtureInput = Readonly<{
  request: Parameters<typeof checkpointActionAuthorityFn>[0]['request']
  destination: Readonly<{ kind: 'host' | 'mcp_server'; ref: string; url: string }> | null
  pathKind?: 'direct' | 'team'
  effectiveTeamId?: string | null
  checkedAt?: string
  validUntil?: string | null
}>

async function main(): Promise<void> {
  installControlApiJwtTestKeys()
  const [
    { AccessExecutionBudget },
    { knownBehavior },
    { checkpointActionAuthority },
    { issueHostMessageAdmissionReceipt },
  ] = await Promise.all([
    import('../../src/services/access/accessExecutionBudget.js'),
    import('../../src/services/access/accessPath.js'),
    import('../../src/services/access/actionAuthorityCheckpoint.js'),
    import('../../src/utils/auth/hostMessageAdmissionReceipt.js'),
  ])
  const input = JSON.parse(process.argv[2] ?? '') as FixtureInput
  const behavior = Object.freeze({
    capabilities: Object.freeze(['fixture.authorized']),
    budget: knownBehavior(null),
    credentialPolicy: knownBehavior(null),
    approvalPolicy: knownBehavior(null),
    filesystemScope: knownBehavior(null),
    runtime: knownBehavior(null),
    providerModelPolicy: knownBehavior(null),
    audit: knownBehavior(`user:${input.request.principal.sub}`),
  })
  const budget = AccessExecutionBudget.create('action-checkpoint-producer-fixture')

  try {
    const response = await checkpointActionAuthority(
      {
        request: input.request,
        gateway: {} as never,
        budget,
        now: new Date(input.checkedAt ?? '2026-08-18T12:00:00.000Z'),
      },
      {
        authorize: async () => ({
          status: 'allowed',
          context: {
            version: 2,
            principal: {
              userId: input.request.principal.sub,
              sid: input.request.principal.sid,
              sessionVersion: input.request.principal.sessionVersion,
            },
            operationId: input.request.operationId,
            resource: input.request.resource,
            target: input.request.target,
            targetHash: input.request.targetHash,
            accessPathId: input.request.accessPathId,
            authorizationRevision: input.request.authorizationRevision,
            behaviorBindingHash: input.request.behaviorBindingHash,
            pathKind: input.pathKind ?? 'direct',
            effectiveTeamId: input.effectiveTeamId ?? null,
            selectedPathCapabilities: ['fixture.authorized'],
            behavior,
            validUntil: input.validUntil ?? null,
          },
          behaviorBindingHash: input.request.behaviorBindingHash,
          operation: {} as never,
          preparedTarget: {
            target: input.request.target,
            targetHash: input.request.targetHash,
          },
        }),
        resolveDestination: async () => ({
          status: 'resolved',
          destination: input.destination,
        }),
      }
    )
    const withAdmissionReceipt =
      response.status === 'allowed' && input.request.operationId === 'chat.message.invoke'
        ? {
            ...response,
            hostMessageAdmissionReceipt:
              input.request.hostMessageAdmission?.receipt ??
              issueHostMessageAdmissionReceipt(
                input.request,
                { service: 'rpc-proxy', trustPlane: 'internal_service_token' },
                input.request.hostMessageAdmission!
              ),
          }
        : response
    process.stdout.write(JSON.stringify(withAdmissionReceipt))
  } finally {
    budget.close()
  }
}

void main()
