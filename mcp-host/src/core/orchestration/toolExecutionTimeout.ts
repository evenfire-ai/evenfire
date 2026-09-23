import { ToolError, ToolErrorCode } from '../errors'
import type { ExecutionContext, Tool } from '../interfaces'
import type { ToolOutput } from '../types'

/** Separate the execution deadline from bounded termination/result collection. */
export async function executeWithTimeout(
  tool: Tool,
  params: Record<string, unknown>,
  context: ExecutionContext,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<ToolOutput> {
  const cleanupMs = tool.timeoutCleanupMs?.() ?? 0
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(cleanupMs) ||
    cleanupMs < 0 ||
    timeoutMs + cleanupMs > 2_147_483_647
  ) {
    throw new Error('Invalid tool execution or cleanup timeout')
  }
  parentSignal?.throwIfAborted()
  const controller = new AbortController()
  let executionTimer: ReturnType<typeof setTimeout> | undefined
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let stop: (reason: unknown) => void
  const deadline = new Promise<never>((_, reject) => {
    stop = reason => {
      if (stopped) return
      stopped = true
      controller.abort(reason)
      if (cleanupMs === 0) reject(reason)
      else cleanupTimer = setTimeout(() => reject(reason), cleanupMs)
    }
    executionTimer = setTimeout(
      () =>
        stop(
          new ToolError(
            `Tool ${tool.name()} timed out after ${timeoutMs}ms`,
            tool.name(),
            ToolErrorCode.Timeout
          )
        ),
      timeoutMs
    )
  })
  const onAbort = () => stop(parentSignal?.reason ?? new Error('Tool execution aborted'))
  parentSignal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([
      tool.execute(params, { ...context, timeoutMs, signal: controller.signal }),
      deadline,
    ])
  } finally {
    clearTimeout(executionTimer)
    clearTimeout(cleanupTimer)
    parentSignal?.removeEventListener('abort', onAbort)
  }
}
