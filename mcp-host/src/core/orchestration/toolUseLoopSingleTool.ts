import { logger } from '../../logger'
import {
  extractToolIntent,
  getDisplayName,
  sanitizeError,
} from '../../progress/intentExtraction.js'
import type { ToolCallTokens } from '../../progress/types.js'
import { ToolError } from '../errors'
import type { ExecutionContext } from '../interfaces'
import { RingBuffer } from '../tools/ringBuffer'
import type { TokenUsage, ToolCall, ToolResult } from '../types'
import type { LoopConfig } from './loopConfig'
import { executeWithTimeout } from './toolExecutionTimeout'
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
    | 'visualInput'
    | 'abortSignal'
    | 'measureToolMessage'
  >,
  iteration?: number,
  transformResult?: (result: ToolResult) => Promise<ToolResult>
): Promise<ToolResult> {
  const { toolRegistry, toolOutputProcessor, events, toolTimeout } = config

  // Post-result hooks see error results too and observe failed calls. A thrown
  // upstream message can carry a secret, so the error text first goes through
  // the tool-output sanitizer the success path applies (`toolOutputProcessor`
  // delegates to `config.safety.sanitizeOutput`), unwrapped: error text keeps
  // its plain shape for the model.
  const errorResult = async (content: string): Promise<ToolResult> => {
    const result: ToolResult = {
      tool_call_id: call.id,
      name: call.name,
      content: config.safety.sanitizeOutput(call.name, content).content,
      is_error: true,
    }
    return transformResult ? transformResult(result) : result
  }

  const tool = toolRegistry.get(call.name)
  let validation = toolOutputProcessor.beforeExecution(call.name, call.arguments)
  if (validation.is_valid) {
    // The execution boundary also receives transformed parameters and frozen
    // approved calls. Validate the effective values, not only pre-policy input.
    validation = (await tool?.validateParams?.(call.arguments)) ?? validation
  }
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
    return errorResult(`Parameter validation failed: ${validation.errors.join(', ')}`)
  }

  if (!tool) return errorResult(`Tool not found: ${call.name}`)

  const renderContent = (content: string): string => {
    if (!tool.requiresSanitization()) return content
    if (!toolOutputProcessor.previewForLlm) {
      throw new Error('measureResult requires ToolOutputProcessor.previewForLlm')
    }
    return toolOutputProcessor.previewForLlm(call.name, content)
  }
  const measureContent = (content: string): number => {
    if (!config.measureToolMessage)
      throw new Error('measureToolMessage is required for bounded native output')
    return config.measureToolMessage({
      role: 'tool',
      name: call.name,
      tool_call_id: call.id,
      content,
    })
  }

  events.emit({
    type: 'tool:called',
    data: { toolName: call.name, toolCallId: call.id },
    timestamp: new Date(),
  })

  let ringBuffer: RingBuffer | null = null
  const executionContext: ExecutionContext = {
    onOutput: chunk => ringBuffer?.append(chunk),
    visualInput: config.visualInput,
    measureResult: config.measureToolMessage
      ? content => measureContent(renderContent(content))
      : undefined,
  }
  let watcherId: NodeJS.Timeout | null = null
  const watcherStartedAt = Date.now()

  let wantsWatcher = false
  let finalizingResult = false
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
    const output = await executeWithTimeout(
      tool,
      call.arguments,
      executionContext,
      toolTimeout,
      config.abortSignal
    )
    logger.debug(
      { toolName: call.name, durationMs: Date.now() - execStart, isError: output.is_error },
      'Tool execution finished'
    )

    const attachments = output.is_error ? undefined : output.attachments
    if (!output.is_error) {
      for (const attachment of attachments ?? []) {
        if (attachment.kind === 'image' && !attachment.visualSource)
          config.visualInput?.budget.observeExternalImage(attachment.dataBase64)
      }
    }
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
    // threshold (and is not an error), persist the blob out-of-band and
    // replace `content` with a rich JSON summary. The lateral `spillover_ref`
    // field carries the URI (P0-002 Opción D) so the resume path can resolve
    // in O(1) without re-parsing the LLM-bound JSON body.
    //
    // A tool whose output is already bounded by its own contract declares
    // `spilloverExempt()` (`clerum__spillover_read` reads back a blob that was
    // spilled once; `clerum__attachment_read` returns the page the caller
    // asked for) and is shipped inline whatever its size (#666, #678).
    //
    // `rawContent` keeps the original blob untouched so the progress reporter
    // (and the workflow read-only fallbacks) still see the real output.
    let finalContent = wrappedContent
    let spilloverRef: string | undefined
    if (
      config.spilloverStorage &&
      config.taskId &&
      !output.is_error &&
      tool.spilloverExempt?.() !== true
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
        logger.error({ toolName: call.name, err }, 'Spillover persistence failed')
      }
    }

    let result: ToolResult = {
      tool_call_id: call.id,
      name: call.name,
      content: finalContent,
      is_error: output.is_error,
      attachments,
      metadata: output.metadata,
      rawContent: output.content,
      spillover_ref: spilloverRef,
    }
    // Post-result hooks execute once. Measure after them; a preview never
    // repeats a hook, tool execution, progress event or spillover write.
    finalizingResult = true
    if (transformResult) result = await transformResult(result)
    if (config.measureToolMessage) {
      result = { ...result, emittedMessageCost: measureContent(result.content) }
    }
    if (tool.finalizeResult) {
      result = await tool.finalizeResult(result, { measureContent, renderContent })
      const finalCost = measureContent(result.content)
      if (result.emittedMessageCost !== finalCost) {
        throw new Error('Final tool-message measurement does not match its budget debit')
      }
    }
    return result
  } catch (err) {
    // A result-policy/finalization failure must stop publication. Turning it
    // into an ordinary tool error could make the model repeat completed work.
    if (finalizingResult) throw err
    const errorMessage =
      err instanceof ToolError ? err.message : `Tool execution failed: ${(err as Error).message}`

    logger.error({ toolName: call.name, err }, 'Tool execution failed')

    return await errorResult(errorMessage)
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
