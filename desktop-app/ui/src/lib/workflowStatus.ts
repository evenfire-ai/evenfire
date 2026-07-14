import type { PluginWorkloadSdkCapabilityStatus } from '../../../src/types'

export function workflowStatusTone(status: string | null | undefined): 'allowed' | 'denied' | '' {
  const normalized = String(status ?? '')
    .trim()
    .toLowerCase()
  if (['active', 'completed', 'running', 'succeeded'].includes(normalized)) return 'allowed'
  if (['canceled', 'cancelled', 'error', 'failed'].includes(normalized)) return 'denied'
  return ''
}

/**
 * Summarize a recipe's Plugin Workload SDK capability projection
 * (status.pluginWorkloadSdk) into a Pill label + tone. Returns null when the
 * recipe does not declare the capability, so callers render nothing.
 */
export function describePluginWorkloadSdkCapability(
  capability: PluginWorkloadSdkCapabilityStatus | null | undefined
): { label: string; tone: 'success' | 'neutral'; title: string } | null {
  if (!capability) return null
  const families = [
    capability.promptBridge ? 'promptBridge' : null,
    capability.clientNotifications ? 'clientNotifications' : null,
  ].filter((f): f is string => f !== null)
  if (capability.state === 'validated') {
    return {
      label: `SDK: ${families.join(', ') || 'none'}`,
      tone: 'success',
      title: `Plugin Workload SDK capability validated (${families.join(', ') || 'none'})`,
    }
  }
  return {
    label: 'SDK: disabled',
    tone: 'neutral',
    title: capability.message || 'Plugin Workload SDK capability is disabled',
  }
}
