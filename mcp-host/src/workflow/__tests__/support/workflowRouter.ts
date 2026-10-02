/**
 * The workflow path for internal tools: StepMcpRouter validates the arguments
 * against the tool's schema before execute() runs.
 */
import { INTERNAL_TOOLS } from '../../internalTools'
import { StepMcpRouter } from '../../stepRouter'
import type { InternalToolDefinition } from '../../types'

/** A step router with every internal tool registered, writing to `outputDir`. */
export function workflowRouter(outputDir: string): StepMcpRouter {
  const router = new StepMcpRouter(() => {
    throw new Error('no MCP server is involved')
  })
  router.registerInternalTools(INTERNAL_TOOLS, outputDir)
  return router
}

/**
 * Whether the step router accepts `args` for `tool`: true, or its error text.
 * The tool itself does not run.
 */
export async function workflowValidation(
  tool: InternalToolDefinition,
  args: Record<string, unknown>
): Promise<true | string> {
  const router = new StepMcpRouter(() => {
    throw new Error('no MCP server is involved')
  })
  router.registerInternalTools([{ ...tool, execute: async () => ({ success: true }) }], '/unused')
  const { result } = await router.callTool(tool.name, structuredClone(args))
  if (!result.isError) return true
  return String((result.content as { error?: unknown }).error)
}
