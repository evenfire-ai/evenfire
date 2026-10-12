import type { FallbackEntry } from '../llm/failover/types'
import { resolveContextWindow } from '../llm/registryCore'

/** Budget pages for every model the same task can actually be sent to. */
export function attachmentContextWindow(
  primaryWindow: number,
  primaryProvider: string,
  fallbacks: readonly FallbackEntry[],
  catalogWindow: ((provider: string, model: string) => number | undefined) | undefined,
  envDefault: number
): number {
  assertWindow(primaryWindow)
  let minimum = primaryWindow
  for (const entry of fallbacks) {
    // R5.7 serves the session model for another key of the same provider.
    if (entry.provider === primaryProvider) continue
    const { contextWindowTokens } = resolveContextWindow(
      entry.provider,
      catalogWindow?.(entry.provider, entry.model),
      envDefault
    )
    assertWindow(contextWindowTokens)
    minimum = Math.min(minimum, contextWindowTokens)
  }
  return minimum
}

function assertWindow(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Attachment context window must be a positive safe integer')
  }
}
