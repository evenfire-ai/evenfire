/**
 * Tool provenance resolution (spec §6, §6.1).
 *
 * Provenance (`native` vs `mcp`, server + name) comes from the REGISTRY, never
 * inferred from a `__` name pattern. The authoritative MCP server identity is
 * `McpTool.serverName` (via `McpManager`), NOT the `__`-split `sourceRef` that
 * `McpToolAdapter.traceDescriptor()` currently derives.
 *
 * TODO(phase1): thread `serverName` from `McpManager` into the resolver and
 * replace the `__` split at `core/adapters/toolRegistryAdapter.ts:100-103`.
 */
import type { ToolTraceDescriptor } from '../../interfaces'

/** The resolved identity the tool-lane boundary evaluates (spec §6 `ResolvedIdentity`). */
export interface ToolIdentity {
  provenance: 'native' | 'mcp'
  /** MCP server name (registry-authoritative), when provenance is `mcp`. */
  server?: string
  /** The real tool name after any dynamic-bridge resolution. */
  name: string
}

/**
 * Map a registry trace descriptor to a lane identity. `serverName` is passed in
 * from the manager (registry-authoritative), NOT parsed from the tool name.
 *
 * TODO(phase1): wire the real `serverName` source; today `descriptor.sourceRef`
 * for MCP tools is still `__`-derived (see file header).
 */
export function resolveToolIdentity(
  name: string,
  descriptor: ToolTraceDescriptor | undefined,
  serverName?: string
): ToolIdentity {
  if (descriptor?.kind === 'mcp_server_tool') {
    return { provenance: 'mcp', server: serverName ?? descriptor.sourceRef ?? undefined, name }
  }
  return { provenance: 'native', name }
}
