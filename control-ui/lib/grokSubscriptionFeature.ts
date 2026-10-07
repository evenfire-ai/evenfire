import { loadSubscriptionCapabilities } from './subscriptionCapabilities'

export type GrokSubscriptionCapability = {
  enabled: boolean
  error?: string
}

export async function loadGrokSubscriptionCapability(): Promise<GrokSubscriptionCapability> {
  const capabilities = await loadSubscriptionCapabilities()
  return { enabled: capabilities.providers['grok-subscription'].enabled }
}

export function isGrokSubscriptionUiEnabled(
  capability: GrokSubscriptionCapability | null | undefined
): boolean {
  return capability?.enabled === true
}
