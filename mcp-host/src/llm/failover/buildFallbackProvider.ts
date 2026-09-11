import { fallbackSlotId } from '@clerum/egress-policy'
import type { ConfigStore } from '../../config/configStore'
import type { ProviderCredentials } from '../../types'
import type { SingleTurnProvider, createLLMProvider } from '../index'
import { type LlmProvider, descriptorFor, isLlmProvider } from '../registryCore'
import type { FallbackEntry } from './types'

/**
 * Build the credential bag for a fallback entry from the LIVE ConfigStore
 * fallback-slot values (same `chatllm-api-keys` Secret). The entry's optional
 * `credentialSlot` overrides the provider's PRIMARY slot source; the remaining
 * (multi-slot) slots read their normal dataKeys. Returns null when any required
 * slot is absent → the engine skips that entry.
 */
function buildFallbackCredentials(
  store: ConfigStore,
  entry: FallbackEntry
): ProviderCredentials | null {
  if (!isLlmProvider(entry.provider)) return null
  const slots = descriptorFor(entry.provider).credentialSlots
  const creds: ProviderCredentials = {}
  slots.forEach((slot, i) => {
    const dataKey = i === 0 && entry.credentialSlot ? entry.credentialSlot : slot.dataKey
    const value = store.fallbackSlotValue(dataKey)
    if (value) creds[slot.dataKey] = value
  })
  for (const slot of slots) {
    if (slot.required && !creds[slot.dataKey]) return null
  }
  return creds
}

/**
 * R5.3 — the fallback provider factory. Builds a fresh provider for `entry`
 * from the live ConfigStore keys (rotation-safe: rebuilt per attempt). Returns
 * null when unconstructible (missing slot / unknown provider). Shared by the
 * per-task/-compact wrappers (via `currentFailoverSupport`) and the boot
 * resolver.
 *
 * Extracted from main.ts so the `slotIndex == null ⇒ null` guard — the only
 * protection against a local fallback dialing the PRIMARY broker — has a pure,
 * testable seam; importing main.ts into a test pulls in the whole service boot.
 * `getStore` is lazy because `configStore` is assigned during boot and replaced
 * on every Host update; `createProvider` is injected for the same reason.
 */
export function createFallbackProviderBuilder(deps: {
  getStore: () => ConfigStore | null
  createProvider: typeof createLLMProvider
}): (entry: FallbackEntry) => SingleTurnProvider | null {
  return entry => {
    const store = deps.getStore()
    if (!store) return null
    const creds = buildFallbackCredentials(store, entry)
    if (!creds) return null
    // A local openai-compatible fallback dials ITS OWN broker, addressed by
    // `fallback-<rawIndex>`. Without slotIndex we cannot derive the right broker,
    // and a missing slotId would otherwise default to the PRIMARY broker below —
    // a dial to the wrong Service. Fail closed instead: no slotIndex, no provider.
    if (entry.provider === 'openai-compatible' && entry.slotIndex == null) return null
    return deps.createProvider(
      { [entry.provider]: creds },
      { provider: entry.provider as LlmProvider, name: entry.model, baseURL: entry.baseURL },
      {
        openaiCompatibleSlotId:
          entry.slotIndex != null ? fallbackSlotId(entry.slotIndex) : undefined,
      }
    )
  }
}
