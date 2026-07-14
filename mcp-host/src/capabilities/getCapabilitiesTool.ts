import type { InternalToolDefinition, InternalToolResult } from '../workflow/types'
import { CAPABILITY_MAP, isCapabilityConfigured } from './capabilityMap'

/**
 * Returns the configured capabilities for the LLM.
 *
 * Output (booleans + static hints, NEVER values):
 *   {
 *     "version": "v1",
 *     "configured": { "github": true, "brave_search": false, "smtp": true },
 *     "hints": { "github": "Available as $GITHUB_TOKEN ...", ... }
 *   }
 *
 * Security invariants:
 *   - No code path returns a secret value.
 *   - Hints are static strings from CAPABILITY_MAP — never derived from a
 *     value. Unit-tested by fuzz: response body is asserted to NOT contain
 *     any substring of any ConfigStore secret value, even when secrets are
 *     set, even when an attacker-supplied capability name is requested.
 *   - LLM provider key (OPENAI_API_KEY etc.) is intentionally absent from
 *     CAPABILITY_MAP — it's not an LLM-visible capability.
 *
 * The env-getter argument is supplied by the caller so this module stays
 * decoupled from ConfigStore wiring; in production it routes ConfigStore
 * → process.env fallback.
 */
export type EnvGetter = (key: string) => string | undefined

export interface GetCapabilitiesResponse {
  version: 'v1'
  configured: Record<string, boolean>
  hints: Record<string, string>
}

export function buildGetCapabilitiesResponse(getEnv: EnvGetter): GetCapabilitiesResponse {
  const configured: Record<string, boolean> = {}
  const hints: Record<string, string> = {}
  for (const cap of CAPABILITY_MAP) {
    const ok = isCapabilityConfigured(cap, getEnv)
    configured[cap.name] = ok
    // Show the hint for every capability whether configured or not — the LLM
    // benefits from knowing which env var name unlocks an integration even
    // when not yet set, so it can correctly direct the operator.
    hints[cap.name] = cap.hint
  }
  return { version: 'v1', configured, hints }
}

/**
 * Build the InternalToolDefinition. Bound to the supplied env-getter so it
 * can be registered alongside the existing `clerum__generate_*` tools in
 * StepMcpRouter (workflow path) and NativeToolRegistry (chat path).
 */
export function createGetCapabilitiesTool(getEnv: EnvGetter): InternalToolDefinition {
  return {
    name: 'clerum__get_capabilities',
    description:
      'Discover which third-party integrations are configured for this Host. ' +
      'Returns a JSON object with `configured` (presence-only booleans) and ' +
      '`hints` (static usage strings — how to call each integration via shell ' +
      'using $VAR expansion). Never returns secret values.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute(): Promise<InternalToolResult> {
      try {
        const payload = buildGetCapabilitiesResponse(getEnv)
        return { success: true, content: JSON.stringify(payload) }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
