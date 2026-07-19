import {
  extractToolIntent,
  getDisplayName,
  sanitizeError,
} from '../../progress/intentExtraction.js'
import type { ToolCallTokens } from '../../progress/types.js'
import { ToolError, ToolErrorCode } from '../errors'
import type { ExecutionContext } from '../interfaces'
import { RingBuffer } from '../tools/ringBuffer'
import type { TokenUsage, ToolCall, ToolResult } from '../types'
import type { LoopConfig } from './loopConfig'
import { buildOutputPreview, extractInputPreview } from './toolUseLoopPreviews'

export async function executeSingleTool(
  call: ToolCall,
  config: Pick<
    LoopConfig,
    | 'toolRegistry'
    | 'toolOutputProcessor'
    | 'safety'
    | 'events'
    | 'toolTimeout'
    | 'progressReporter'
    | 'toolProgressInterval'
    | 'spilloverStorage'
    | 'taskId'
  >,
  iteration?: number
): Promise<ToolResult> {
  const { toolRegistry, toolOutputProcessor, events, toolTimeout } = config

  const validation = toolOutputProcessor.beforeExecution(call.name, call.arguments)
  if (!validation.is_valid) {
    events.emit({
      type: 'safety:input_blocked',
      data: {
        toolName: call.name,
        errors: validation.errors,
        ...(iteration !== undefined && { iteration }),
      },
      timestamp: new Date(),
    })
    return {
      tool_call_id: call.id,
      name: call.name,
      content: `Parameter validation failed: ${validation.errors.join(', ')}`,
      is_error: true,
    }
  }

  const tool = toolRegistry.get(call.name)
  if (!tool) {
    return {
      tool_call_id: call.id,
      name: call.name,
      content: `Tool not found: ${call.name}`,
      is_error: true,
    }
  }

  events.emit({
    type: 'tool:called',
    data: { toolName: call.name, toolCallId: call.id },
    timestamp: new Date(),
  })

  let ringBuffer: RingBuffer | null = null
  let executionContext: ExecutionContext | undefined
  let watcherId: NodeJS.Timeout | null = null
  const watcherStartedAt = Date.now()

  let wantsWatcher = false
  try {
    wantsWatcher =
      typeof tool.supportsProgressOutput === 'function' &&
      tool.supportsProgressOutput() === true &&
      !!config.progressReporter &&
      (config.toolProgressInterval ?? 0) > 0
  } catch {
    wantsWatcher = false
  }

  if (wantsWatcher) {
    ringBuffer = new RingBuffer(64 * 1024)
    const buf = ringBuffer
    executionContext = { onOutput: (chunk: string) => buf.append(chunk) }
    watcherId = setInterval(() => {
      try {
        const snapshot = buf.snapshot()
        const sanitized = snapshot
          ? config.safety.sanitizeOutput(call.name, snapshot).content
          : undefined
        const outputPreview = sanitized ? buildOutputPreview(sanitized) : undefined
        config.progressReporter!.reportToolProgress({
          taskId: '',
          toolCallId: call.id,
          toolName: call.name,
          elapsedMs: Date.now() - watcherStartedAt,
          outputPreview,
        })
      } catch {
        // Observability failure is not a task failure.
      }
    }, config.toolProgressInterval)
  }

  try {
    const execStart = Date.now()
    const output = await Promise.race([
      tool.execute(call.arguments, executionContext),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new ToolError(
                `Tool ${call.name} timed out after ${toolTimeout}ms`,
                call.name,
                ToolErrorCode.Timeout
              )
            ),
          toolTimeout
        )
      ),
    ])

    console.log(
      `[NewCore:Loop] exec ${call.name} → ${Date.now() - execStart}ms, ${output.is_error ? 'error' : 'ok'}`
    )

    let wrappedContent: string
    if (tool.requiresSanitization()) {
      wrappedContent = toolOutputProcessor.afterExecution(call.name, output)
      if (wrappedContent !== output.content) {
        events.emit({
          type: 'safety:output_sanitized',
          data: {
            toolName: call.name,
            originalLength: output.content.length,
            sanitizedLength: wrappedContent.length,
            ...(iteration !== undefined && { iteration }),
          },
          timestamp: new Date(),
        })
      }
    } else {
      wrappedContent = output.content
    }

    const traceDescriptor = tool.traceDescriptor?.(call.arguments, output) ?? {
      kind: 'internal_tool' as const,
      sourceRef: 'mcp-host',
    }
    events.emit({
      type: 'tool:completed',
      data: {
        toolName: call.name,
        toolCallId: call.id,
        duration_ms: output.duration_ms,
        is_error: output.is_error,
        toolKind: traceDescriptor.kind,
        toolSourceRef: traceDescriptor.sourceRef,
      },
      timestamp: new Date(),
    })

    // T1.5 — Spillover. If the sanitized output exceeds the configured byte
    // threshold (and the tool isn't itself `clerum__spillover_read` or an
    // error), persist the blob out-of-band and replace `content` with a
    // rich JSON summary. The lateral `spillover_ref` field carries the URI
    // (P0-002 Opción D) so the resume path can resolve in O(1) without
    // re-parsing the LLM-bound JSON body.
    //
    // `rawContent` keeps the original blob untouched so the progress reporter
    // (and the workflow read-only fallbacks) still see the real output.
    let finalContent = wrappedContent
    let spilloverRef: string | undefined
    if (
      config.spilloverStorage &&
      config.taskId &&
      !output.is_error &&
      call.name !== 'clerum__spillover_read'
    ) {
      try {
        const summary = await config.spilloverStorage.maybePersist({
          taskId: config.taskId,
          toolCallId: call.id,
          toolName: call.name,
          content: wrappedContent,
          isError: false,
        })
        if (summary) {
          finalContent = JSON.stringify(summary)
          spilloverRef = summary.spillover_ref
          events.emit({
            type: 'spillover:persisted',
            data: {
              toolName: call.name,
              byteSize: summary.byte_size,
              ref: summary.spillover_ref,
            },
            timestamp: new Date(),
          })
        }
      } catch (err) {
        // Spillover is an optimization; persistence failure must NOT lose the
        // tool result. Log and fall through with the inline content.
        console.error(
          `[NewCore:Loop] spillover persist failed for ${call.name}: ${(err as Error).message}`
        )
      }
    }

    return {
      tool_call_id: call.id,
      name: call.name,
      content: finalContent,
      is_error: output.is_error,
      attachments: output.attachments,
      metadata: output.metadata,
      rawContent: output.content,
      spillover_ref: spilloverRef,
    }
  } catch (err) {
    const errorMessage =
      err instanceof ToolError ? err.message : `Tool execution failed: ${(err as Error).message}`

    console.log(`[NewCore:Loop] exec ${call.name} → FAILED: ${errorMessage}`)

    return {
      tool_call_id: call.id,
      name: call.name,
      content: errorMessage,
      is_error: true,
    }
  } finally {
    if (watcherId) {
      clearInterval(watcherId)
      watcherId = null
    }
  }
}

export function reportToolStart(
  config: LoopConfig,
  call: ToolCall,
  iteration: number,
  stepIndex: number,
  totalSteps: number,
  llmTextContent?: string
): number {
  const displayName = getDisplayName(call.name)
  const progressStart = Date.now()
  config.progressReporter?.reportToolStart({
    taskId: '',
    toolCallId: call.id,
    toolName: call.name,
    displayName,
    intentSummary:
      extractToolIntent(llmTextContent ?? null, call.name) ?? `Using ${displayName}...`,
    iteration,
    stepIndex,
    totalSteps,
    inputPreview: extractInputPreview(call.name, call.arguments),
  })
  return progressStart
}

export function reportToolComplete(
  config: LoopConfig,
  call: ToolCall,
  toolResult: ToolResult,
  progressStart: number,
  iteration: number,
  stepIndex: number,
  totalSteps: number,
  usage?: TokenUsage
): void {
  if (!config.progressReporter) return
  const rawForPreview = toolResult.rawContent ?? toolResult.content
  const previewContent = config.safety.sanitizeOutput(call.name, rawForPreview).content
  config.progressReporter.reportToolComplete({
    taskId: '',
    toolCallId: call.id,
    toolName: call.name,
    displayName: getDisplayName(call.name),
    durationMs: Date.now() - progressStart,
    isError: toolResult.is_error ?? false,
    errorSummary: toolResult.is_error ? sanitizeError(toolResult.content) : undefined,
    iteration,
    stepIndex,
    totalSteps,
    outputPreview: buildOutputPreview(previewContent),
    metadata: toolResult.metadata,
    tokens: projectToolCallTokens(usage),
  })
}

export function projectToolCallTokens(usage?: TokenUsage): ToolCallTokens | undefined {
  if (!usage) return undefined
  if (usage.input_tokens + usage.output_tokens === 0) return undefined
  const tokens: ToolCallTokens = {
    input: usage.input_tokens,
    output: usage.output_tokens,
  }
  // A defined cache_* field IS the "provider reports cache" signal (same
  // convention as projectTurnTokens): Anthropic's defined 0 is included,
  // OpenAI's undefined is omitted.
  if (usage.cache_read_tokens !== undefined || usage.cache_write_tokens !== undefined) {
    tokens.cacheRead = usage.cache_read_tokens ?? 0
    tokens.cacheWrite = usage.cache_write_tokens ?? 0
  }
  return tokens
}
