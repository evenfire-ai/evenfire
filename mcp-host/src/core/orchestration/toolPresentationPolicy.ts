import { BRIDGE_TOOL_NAMES } from '../../capabilities/toolCatalogTools'
import type { ToolDefinition } from '../types'

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

/**
 * Native-tool presentation (#1003). Independent of `CodexToolPresentation` and of
 * the legacy `CLERUM_DYNAMIC_TOOLS_ENABLED` latch, which only govern MCP tools.
 * - `direct`: every native stays in `tools[]` (identical to the pre-#1003 host).
 * - `auto`: natives whose serialized definition exceeds the native discovery
 *   budget leave `tools[]` and are reached through search/describe/call.
 */
export type NativeToolPresentation = 'direct' | 'auto'

export function parseNativeToolPresentation(raw: string | undefined): NativeToolPresentation {
  if (raw === undefined) return 'direct'
  if (raw === 'direct' || raw === 'auto') return raw
  throw new Error('CLERUM_NATIVE_TOOL_PRESENTATION must be direct or auto')
}

export const DEFAULT_NATIVE_TOOL_DISCOVERY_BYTES = 2_048

/**
 * Per-native-tool serialized-definition budget used by native `auto`. Parsed even
 * in `direct`, so a bad value fails at startup instead of on the first switch.
 */
export function parseNativeToolDiscoveryBytes(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_NATIVE_TOOL_DISCOVERY_BYTES
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('CLERUM_NATIVE_TOOL_DISCOVERY_BYTES must be a positive safe integer')
  }
  return Number(raw)
}

/**
 * Names of the natives that native `auto` removes from `tools[]`: every native
 * whose FULL serialized definition (name + description + parameters, exactly
 * what `tools[]` costs) exceeds `budget`. Size-driven, never name-driven. The
 * bridge tools are never selected: they are the access path to everything else.
 */
export function selectDeferredNatives(
  definitions: ReadonlyArray<ToolDefinition>,
  nativeNames: ReadonlySet<string>,
  budget: number
): Set<string> {
  return new Set(
    definitions
      .filter(
        def =>
          nativeNames.has(def.name) &&
          !BRIDGE_TOOL_NAMES.has(def.name) &&
          Buffer.byteLength(JSON.stringify(def), 'utf8') > budget
      )
      .map(def => def.name)
  )
}

export function resolveToolPresentation(
  provider: string,
  config: { dynamicToolsEnabled: boolean; codexToolPresentation?: CodexToolPresentation },
  fallbacks: ReadonlyArray<{ provider: string }> = []
): { bridgeEnabled: boolean; codexMode?: CodexToolPresentation } {
  // A fallback reuses the same tool request, so choose a presentation executable
  // and optimized across the configured provider chain before the first attempt.
  if (
    isOauthBrokerPresentationTarget(provider) ||
    fallbacks.some(entry => isOauthBrokerPresentationTarget(entry.provider))
  ) {
    const codexMode = config.codexToolPresentation ?? 'direct'
    return { bridgeEnabled: codexMode !== 'direct', codexMode }
  }
  return { bridgeEnabled: config.dynamicToolsEnabled }
}

function isOauthBrokerPresentationTarget(provider: string): boolean {
  return provider === 'codex-subscription' || provider === 'grok-subscription'
}
