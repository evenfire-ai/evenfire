import { withAccessDatabaseTransaction } from './accessDatabaseQuery.js'
import { AccessExecutionBudget } from './accessExecutionBudget.js'
import { revisionOfValues } from './authorizationRevision.js'
import { canonicalEnvironmentId } from './operationalAccessProjection.js'
import { assemblePr2Readiness } from './pr2ReadinessEvidence.js'
import {
  type ConfiguredUserAccessIntent,
  type DeploymentReadiness,
  type EffectiveUserAccessPolicy,
  compileUserAccessPolicy,
  configuredUserAccessIntent,
  reconstructionReadiness,
} from './userAccessPolicy.js'

type RuntimePolicyOptions = Readonly<{
  intent?: ConfiguredUserAccessIntent
  budget?: AccessExecutionBudget
}>

function needsPr2Readiness(intent: ConfiguredUserAccessIntent): boolean {
  return intent.actionContextV2 || intent.rpcDelegationV2
}

/**
 * PR 2 readiness is database evidence that changes at runtime, so it is read
 * for every call that needs it and never cached with the compiled policy.
 */
async function pr2RuntimeReadiness(
  budget: AccessExecutionBudget | undefined
): Promise<DeploymentReadiness> {
  const ownedBudget = budget ? null : AccessExecutionBudget.create('action')
  const activeBudget = budget ?? ownedBudget!
  try {
    const servingSourceRevision = process.env.EVENFIRE_SOURCE_REVISION?.trim() ?? ''
    const pr2RuntimeHops = await withAccessDatabaseTransaction(
      activeBudget,
      db => assemblePr2Readiness(db, canonicalEnvironmentId(), undefined, servingSourceRevision),
      { mode: 'read_only' }
    )
    return Object.freeze({
      ...reconstructionReadiness,
      revision: revisionOfValues([reconstructionReadiness.revision, pr2RuntimeHops]),
      pr2RuntimeHops,
    })
  } finally {
    ownedBudget?.close()
  }
}

// Valid only while the configured intent and readiness are process constants,
// so it holds only a configured intent that needs no PR 2 readiness.
let defaultPolicy: EffectiveUserAccessPolicy | undefined

export async function resolveEffectiveUserAccessPolicy(
  options: RuntimePolicyOptions = {}
): Promise<EffectiveUserAccessPolicy> {
  const intent = options.intent ?? configuredUserAccessIntent
  if (needsPr2Readiness(intent)) {
    return compileUserAccessPolicy(intent, await pr2RuntimeReadiness(options.budget))
  }
  if (options.intent) return compileUserAccessPolicy(options.intent, reconstructionReadiness)
  return (defaultPolicy ??= compileUserAccessPolicy(
    configuredUserAccessIntent,
    reconstructionReadiness
  ))
}
