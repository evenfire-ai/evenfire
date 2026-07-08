import type { WorkflowRecipeSpec } from '../types'

/** K8s Secret data key for a single workload's SDK bearer token. */
export function pluginWorkloadSdkTokenSecretKey(callerRef: string): string {
  return `caller-${callerRef}`
}

/** Returns true when existing Secret data matches the desired per-caller tokens. */
export function pluginWorkloadSdkSecretTokensMatch(
  existingDecoded: Record<string, string>,
  tokensByCaller: Record<string, string>
): boolean {
  const desiredKeys = new Set(
    Object.keys(tokensByCaller).map(callerRef => pluginWorkloadSdkTokenSecretKey(callerRef))
  )
  for (const [callerRef, token] of Object.entries(tokensByCaller)) {
    if (existingDecoded[pluginWorkloadSdkTokenSecretKey(callerRef)] !== token) return false
  }
  for (const key of Object.keys(existingDecoded)) {
    if (key.startsWith('caller-') && !desiredKeys.has(key)) return false
  }
  return true
}

/**
 * Resolve which workload ids receive a per-caller SDK token. Mirrors
 * buildPluginWorkloadSdkEnv eligibility: non-transport sandbox workloads,
 * excluding the sandbox UI workload.
 */
export function resolvePluginWorkloadSdkAllowedCallers(spec: WorkflowRecipeSpec): string[] {
  const sdk = spec.pluginWorkloadSdk
  if (!sdk) return []

  const workloads = spec.workloads ?? []
  const uiRef = spec.ui?.workloadRef
  const eligible = workloads.filter(w => !w.transport && w.id !== uiRef).map(w => w.id)

  const allowedCallers = sdk.allowedCallers ?? []
  if (allowedCallers.length === 0) return eligible
  return eligible.filter(id => allowedCallers.includes(id))
}
