/**
 * Provider-aware tool presentation for `codex-subscription` (#627).
 *
 * The previous behaviour (`selectCodexAdvertisedTools`) kept only names that
 * looked native and sliced the result to the shared contract's 32. That dropped
 * EVERY approved connector/plugin MCP tool before the request was authorized,
 * so a Codex agent could connect to a service, load its tools, and still be
 * unable to use any of them. It also silently truncated natives: the three
 * discovery/bridge tools register LAST, so a host with more than 32 natives lost
 * exactly the tools that would have made the rest reachable.
 *
 * The replacement holds one invariant:
 *
 *   presented ∪ reachable-through-the-bridge = everything offered
 *
 * so capacity pressure never removes a capability, it only moves it from
 * "advertised directly" to "reachable via clerum__tool_search / clerum__tool_call".
 * Where that cannot be honoured the outcome says so explicitly instead of
 * quietly shortening the list.
 *
 * This module decides PRESENTATION only. Whether a tool is permitted at all is
 * the registry's and the approval/guardrail chain's decision, and deferral
 * policy for large catalogs is `DeferrableToolController`'s. Nothing here
 * widens access: every deferred tool still executes through the same registry,
 * approval gate and authenticated principal as a directly advertised one.
 */
import { ToolDefinition } from '../core/types'

/**
 * The discovery + execution bridge. These are the tools that make a deferred
 * catalog reachable, so they are reserved ahead of everything else — losing one
 * to capacity would strand every tool it was meant to reach.
 *
 * Order is fixed so the presented array stays byte-stable across turns, which
 * is what keeps the prompt cache warm.
 */
export const CODEX_BRIDGE_TOOL_NAMES = [
  'clerum__tool_search',
  'clerum__tool_describe',
  'clerum__tool_call',
] as const

/** The two bridge tools that must BOTH be present for deferral to be safe. */
const REQUIRED_BRIDGE_TOOLS = ['clerum__tool_search', 'clerum__tool_call'] as const

/**
 * Whether a tool is reachable through `clerum__tool_call` when deferred.
 *
 * MCP tools are exposed as `serverName__toolName`; native tools are unprefixed
 * (`file_read`, `workflow_trigger`) or carry the reserved `clerum__` prefix.
 * Only MCP tools are in the bridge's catalog, so only they may be deferred —
 * deferring a native would strand it.
 *
 * NOTE (known edge): an MCP server literally named `clerum` would be misread as
 * native and therefore never deferred. That direction is safe (it stays
 * advertised or reports a capacity failure; it is never silently dropped), and
 * `clerum__` is reserved for internal tools precisely to avoid the collision.
 */
export function isCodexNativeToolName(name: string): boolean {
  const idx = name.indexOf('__')
  if (idx <= 0) return true
  return name.startsWith('clerum__')
}

export type CodexToolPresentationOutcome =
  /** Everything offered is advertised directly. */
  | 'complete'
  /**
   * Some MCP tools were moved to the bridge to fit capacity. No capability was
   * lost — each deferred tool is reachable via clerum__tool_search/tool_call.
   */
  | 'deferred'
  /**
   * Capacity forced tools out of the request with no bridge to reach them.
   * The caller MUST surface this; it is the one outcome where the invariant
   * above does not hold.
   */
  | 'capacity_exceeded'

export type CodexToolPresentation = {
  /** The tool definitions to put on the wire, in a stable order. */
  presented: ToolDefinition[]
  /** Reachable via the bridge rather than advertised directly. */
  deferredCount: number
  /** Dropped with no way to reach them. Non-zero only on `capacity_exceeded`. */
  unreachableCount: number
  outcome: CodexToolPresentationOutcome
  /** The capacity actually applied, after clamping. */
  capacity: number
}

/**
 * Thrown when the discovery bridge itself cannot fit. That is a configuration
 * error, not a catalog-size problem: a capacity below the bridge's own size
 * leaves no way to present anything coherently.
 */
export class CodexToolCapacityError extends Error {
  readonly code = 'tool_capacity_invalid'
  constructor(message: string) {
    super(message)
    this.name = 'CodexToolCapacityError'
  }
}

/**
 * Choose what a single Codex request advertises.
 *
 * Priority, highest first:
 *   1. the bridge tools that are present in `tools` (reserved — never dropped),
 *   2. the remaining native tools, in registry order,
 *   3. the MCP tools, in registry order.
 *
 * Natives outrank MCP because only MCP is reachable once deferred. Within each
 * band the offered order is preserved so the result is deterministic for a
 * given catalog — a shuffled `tools[]` would invalidate the prompt cache every
 * turn.
 */
export function presentCodexTools(
  tools: ToolDefinition[],
  options: { capacity: number }
): CodexToolPresentation {
  const capacity = Math.max(0, Math.floor(options.capacity))
  const bridgeNames = new Set<string>(CODEX_BRIDGE_TOOL_NAMES)

  const reserved: ToolDefinition[] = []
  const natives: ToolDefinition[] = []
  const deferrable: ToolDefinition[] = []
  for (const tool of tools) {
    if (bridgeNames.has(tool.name)) reserved.push(tool)
    else if (isCodexNativeToolName(tool.name)) natives.push(tool)
    else deferrable.push(tool)
  }
  // Reserve in the canonical order above, not in whatever order the registry
  // happened to emit, so the prefix of `presented` is identical across turns.
  reserved.sort(
    (a, b) =>
      CODEX_BRIDGE_TOOL_NAMES.indexOf(a.name as (typeof CODEX_BRIDGE_TOOL_NAMES)[number]) -
      CODEX_BRIDGE_TOOL_NAMES.indexOf(b.name as (typeof CODEX_BRIDGE_TOOL_NAMES)[number])
  )

  if (capacity < reserved.length) {
    throw new CodexToolCapacityError(
      `codex tool capacity ${capacity} cannot hold ${reserved.length} reserved discovery tool(s)`
    )
  }

  // Deferral is only safe when the agent can actually search AND invoke.
  // clerum__tool_describe is a convenience; without search or call, a deferred
  // tool is simply gone, so a partial bridge counts as no bridge.
  const presentNames = new Set(reserved.map(tool => tool.name))
  const bridgeAvailable = REQUIRED_BRIDGE_TOOLS.every(name => presentNames.has(name))

  const presented = [...reserved]
  let unreachableCount = 0

  for (const tool of natives) {
    if (presented.length < capacity) presented.push(tool)
    // A native that does not fit has nowhere to go: the bridge's catalog is the
    // MCP catalog, so it is genuinely lost and must be reported.
    else unreachableCount += 1
  }

  let deferredCount = 0
  for (const tool of deferrable) {
    if (bridgeAvailable) {
      // With the bridge up, MCP tools are reached through it. Deferring them
      // unconditionally — rather than filling leftover slots — keeps `tools[]`
      // stable as servers connect and disconnect mid-session.
      deferredCount += 1
    } else if (presented.length < capacity) {
      presented.push(tool)
    } else {
      unreachableCount += 1
    }
  }

  const outcome: CodexToolPresentationOutcome =
    unreachableCount > 0 ? 'capacity_exceeded' : deferredCount > 0 ? 'deferred' : 'complete'

  return { presented, deferredCount, unreachableCount, outcome, capacity }
}
