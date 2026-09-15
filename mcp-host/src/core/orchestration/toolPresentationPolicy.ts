/** Presentation changes context cost, never the approved catalog or execution permissions. */
export type CodexToolPresentation = 'auto' | 'direct' | 'discovery'

export function parseCodexToolPresentation(raw: string | undefined): CodexToolPresentation {
  if (raw === undefined) return 'direct'
  if (raw === 'auto' || raw === 'direct' || raw === 'discovery') return raw
  throw new Error('CODEX_TOOL_PRESENTATION must be auto, direct, or discovery')
}

/** An optimization threshold, not a transport limit or an access restriction. */
export function parseCodexToolDiscoveryBytes(raw: string | undefined): number {
  if (raw === undefined) return 32_768
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('CODEX_TOOL_DISCOVERY_BYTES must be a positive safe integer')
  }
  return Number(raw)
}

export function resolveToolPresentation(
  provider: string,
  config: { dynamicToolsEnabled: boolean; codexToolPresentation?: CodexToolPresentation },
  fallbacks: ReadonlyArray<{ provider: string }> = []
): { bridgeEnabled: boolean; codexMode?: CodexToolPresentation } {
  // A fallback reuses the same tool request, so choose a presentation executable
  // and optimized across the configured provider chain before the first attempt.
  if (
    provider === 'codex-subscription' ||
    fallbacks.some(entry => entry.provider === 'codex-subscription')
  ) {
    const codexMode = config.codexToolPresentation ?? 'direct'
    return { bridgeEnabled: codexMode !== 'direct', codexMode }
  }
  return { bridgeEnabled: config.dynamicToolsEnabled }
}
