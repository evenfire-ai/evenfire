import {
  type ConfiguredUserAccessIntent,
  type EffectiveUserAccessPolicy,
  compileUserAccessPolicy,
  configuredUserAccessIntent,
  reconstructionReadiness,
} from './userAccessPolicy.js'

type RuntimePolicyOptions = Readonly<{
  intent?: ConfiguredUserAccessIntent
}>

export async function resolveEffectiveUserAccessPolicy(
  options: RuntimePolicyOptions = {}
): Promise<EffectiveUserAccessPolicy> {
  return compileUserAccessPolicy(
    options.intent ?? configuredUserAccessIntent,
    reconstructionReadiness
  )
}
