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
import type { ToolRegistry, ToolTraceDescriptor } from '../../interfaces'

/** The resolved identity the tool-lane boundary evaluates (spec §6 `ResolvedIdentity`). */
export interface ToolIdentity {
  provenance: 'native' | 'mcp'
  /** MCP server name (registry-authoritative), when provenance is `mcp`. */
  server?: string
  /** The real tool name after any dynamic-bridge resolution. */
  name: string
}

/**
 * Map a registry trace descriptor to a lane identity. For MCP tools the server is
 * `descriptor.sourceRef`, which `McpToolAdapter` fills from the registry's own
 * `McpTool.serverName` — never parsed from the tool name. The optional
 * `serverName` override exists for callers that resolved the server by another
 * route (the dynamic bridge); it wins when supplied.
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

/**
 * Resolve a resolved tool call's identity from the REGISTRY (spec §6) — the
 * provenance comes from `tool.traceDescriptor().kind`, never from the tool name.
 * An unknown tool defaults to `native` (the composite registry resolves native
 * first; an unresolved name is treated as native for matching purposes).
 *
 * The MCP `server` is registry-authoritative: `McpToolAdapter` stamps
 * `McpTool.serverName` into `sourceRef` at registration. It is NOT parsed out of
 * the display name — that guess truncates a server whose own name contains `__`,
 * and a `server=` rule that fails to match is a deny that does not deny.
 */
export function resolveToolIdentityFromRegistry(
  name: string,
  registry: ToolRegistry,
  args: Record<string, unknown> = {}
): ToolIdentity {
  const tool = registry.get(name)
  const descriptor = tool?.traceDescriptor?.(args)
  return resolveToolIdentity(name, descriptor)
}
