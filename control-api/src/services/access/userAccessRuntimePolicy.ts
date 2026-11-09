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
 * PR 2 readiness is database evidence that changes at runtime: a writer's new,
 * failed or withdrawn evidence, an operator activation, and runtime evidence
 * ageing past the activation's freshness bound. Each process keeps the last
 * assembled readiness for at most this long, counted from the start of the
 * read that produced it, so every replica sees a change within this bound.
 * It equals the minimum runtime-evidence write interval (the control-api
 * writer runs at least 1 s apart and the service reporters refuse a shorter
 * interval), so the cache never hides more than one reporting interval.
 */
const PR2_READINESS_CACHE_TTL_MS = 1_000

type CachedPr2Readiness = Readonly<{
  key: string
  expiresAt: number
  readiness: DeploymentReadiness
}>

let cachedPr2Readiness: CachedPr2Readiness | undefined
let pr2ReadinessInFlight: Readonly<{ key: string; read: Promise<DeploymentReadiness> }> | undefined

async function readPr2RuntimeReadiness(
  environmentId: string,
  servingSourceRevision: string
): Promise<DeploymentReadiness> {
  // The read is shared by every caller waiting on it, so it owns its budget:
  // one caller's request budget must not cancel the others' read.
  const budget = AccessExecutionBudget.create('action')
  try {
    const pr2RuntimeHops = await withAccessDatabaseTransaction(
      budget,
      db => assemblePr2Readiness(db, environmentId, undefined, servingSourceRevision),
      { mode: 'read_only' }
    )
    return Object.freeze({
      ...reconstructionReadiness,
      revision: revisionOfValues([reconstructionReadiness.revision, pr2RuntimeHops]),
      pr2RuntimeHops,
    })
  } finally {
    budget.close()
  }
}

/**
 * The cached readiness while it is fresh; otherwise one read that concurrent
 * misses share. A failed read is never cached: the next call reads again.
 */
function sharedPr2RuntimeReadiness(): Promise<DeploymentReadiness> {
  const environmentId = canonicalEnvironmentId()
  const servingSourceRevision = process.env.EVENFIRE_SOURCE_REVISION?.trim() ?? ''
  const key = `${environmentId}\n${servingSourceRevision}`
  const startedAt = Date.now()
  if (cachedPr2Readiness?.key === key && startedAt < cachedPr2Readiness.expiresAt) {
    return Promise.resolve(cachedPr2Readiness.readiness)
  }
  if (pr2ReadinessInFlight?.key === key) return pr2ReadinessInFlight.read
  const read: Promise<DeploymentReadiness> = readPr2RuntimeReadiness(
    environmentId,
    servingSourceRevision
  )
    .then(readiness => {
      cachedPr2Readiness = Object.freeze({
        key,
        expiresAt: startedAt + PR2_READINESS_CACHE_TTL_MS,
        readiness,
      })
      return readiness
    })
    .finally(() => {
      if (pr2ReadinessInFlight?.read === read) pr2ReadinessInFlight = undefined
    })
  pr2ReadinessInFlight = Object.freeze({ key, read })
  return read
}

/**
 * A caller with a request budget waits for the shared read only until its own
 * deadline; the read itself keeps its own bound.
 */
async function pr2RuntimeReadiness(
  budget: AccessExecutionBudget | undefined
): Promise<DeploymentReadiness> {
  const readiness = sharedPr2RuntimeReadiness()
  return budget ? budget.untilDeadline(readiness) : readiness
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
