import { apiGet } from './api'
import type { ApiRequestOptions } from './api.types'

export const SUBSCRIPTION_CAPABILITIES_API_PATH = '/api/v1/admin/llm/providers/capabilities'

export type SubscriptionCapabilityProviderId = 'codex-subscription' | 'grok-subscription'

export type SubscriptionCapabilities = {
  providers: Record<SubscriptionCapabilityProviderId, { enabled: boolean }>
}

export type SubscriptionCapabilityLoadOptions = {
  refresh?: boolean
  signal?: AbortSignal
}

function providerId(value: string): SubscriptionCapabilityProviderId | null {
  return value === 'codex-subscription' || value === 'grok-subscription' ? value : null
}

export function sanitizeSubscriptionCapabilities(raw: unknown): SubscriptionCapabilities {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Subscription capabilities response is not an object')
  }
  const providers = (raw as { providers?: unknown }).providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    throw new Error('Subscription capabilities providers are invalid')
  }
  const result = {
    providers: {
      'codex-subscription': { enabled: false },
      'grok-subscription': { enabled: false },
    },
  } as SubscriptionCapabilities
  let seenCodex = false
  let seenGrok = false
  for (const [id, value] of Object.entries(providers as Record<string, unknown>)) {
    const provider = providerId(id)
    if (!provider) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Subscription capability for ${id} is invalid`)
    }
    const enabled = (value as { enabled?: unknown }).enabled
    if (typeof enabled !== 'boolean') {
      throw new Error(`Subscription capability for ${id} is invalid`)
    }
    result.providers[provider] = { enabled }
    seenCodex ||= provider === 'codex-subscription'
    seenGrok ||= provider === 'grok-subscription'
  }
  if (!seenCodex || !seenGrok) {
    throw new Error('Subscription capabilities response is incomplete')
  }
  return result
}

export async function loadSubscriptionCapabilities(
  options: SubscriptionCapabilityLoadOptions = {}
): Promise<SubscriptionCapabilities> {
  const requestOptions: ApiRequestOptions = {
    signal: options.signal,
    refresh: options.refresh,
    metadataRead: 'subscription-capabilities',
  }
  return sanitizeSubscriptionCapabilities(
    await apiGet(SUBSCRIPTION_CAPABILITIES_API_PATH, {}, requestOptions)
  )
}
