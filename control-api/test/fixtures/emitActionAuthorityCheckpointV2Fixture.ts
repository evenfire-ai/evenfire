import { AccessExecutionBudget } from '../../src/services/access/accessExecutionBudget.js'
import { knownBehavior } from '../../src/services/access/accessPath.js'
import { checkpointActionAuthority } from '../../src/services/access/actionAuthorityCheckpoint.js'

type FixtureInput = Readonly<{
  request: Parameters<typeof checkpointActionAuthority>[0]['request']
  destination: Readonly<{ kind: 'host' | 'mcp_server'; ref: string; url: string }> | null
  pathKind?: 'direct' | 'team'
  effectiveTeamId?: string | null
  checkedAt?: string
  validUntil?: string | null
}>

async function main(): Promise<void> {
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
    process.stdout.write(JSON.stringify(response))
  } finally {
    budget.close()
  }
}

void main()
