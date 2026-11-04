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

// Valid only while the configured intent and readiness are process constants.
let defaultPolicy: EffectiveUserAccessPolicy | undefined

export async function resolveEffectiveUserAccessPolicy(
  options: RuntimePolicyOptions = {}
): Promise<EffectiveUserAccessPolicy> {
  if (options.intent) return compileUserAccessPolicy(options.intent, reconstructionReadiness)
  return (defaultPolicy ??= compileUserAccessPolicy(
    configuredUserAccessIntent,
    reconstructionReadiness
  ))
}
