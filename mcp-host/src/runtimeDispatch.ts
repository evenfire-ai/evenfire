import type { McpHostRuntimeKind } from './config'

export interface McpHostRuntimeStarters {
  standalone: () => Promise<void>
  workflow: () => Promise<void>
  sdkOnly: () => Promise<void>
}

/** Exhaustive startup dispatch for the three disjoint mcp-host products. */
export async function dispatchMcpHostRuntime(
  kind: McpHostRuntimeKind,
  starters: McpHostRuntimeStarters
): Promise<void> {
  switch (kind) {
    case 'standalone':
      await starters.standalone()
      return
    case 'workflow':
      await starters.workflow()
      return
    case 'sdk-only':
      await starters.sdkOnly()
      return
    default: {
      const exhaustive: never = kind
      throw new Error(`Unhandled mcp-host runtime kind: ${String(exhaustive)}`)
    }
  }
}
