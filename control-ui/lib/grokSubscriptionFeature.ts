import { isDisabledCapabilityError } from './codexSubscriptionFeature'
import { listGrokSubscriptionConnections } from './grokSubscription'

export type GrokSubscriptionCapability = {
  enabled: boolean
  error?: string
}

const DISABLED_CAPABILITY: GrokSubscriptionCapability = { enabled: false }

/**
 * Control UI default is off. Capability is proven only by a successful
 * keyed connections list — never the Codex un-keyed `/connection` alias.
 */
export async function loadGrokSubscriptionCapability(): Promise<GrokSubscriptionCapability> {
  try {
    await listGrokSubscriptionConnections()
    return { enabled: true }
  } catch (error) {
    if (isDisabledCapabilityError(error)) return DISABLED_CAPABILITY
    throw error
  }
}

export function isGrokSubscriptionUiEnabled(
  capability: GrokSubscriptionCapability | null | undefined
): boolean {
  return capability?.enabled === true
}
