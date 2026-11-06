/**
 * Protocol-independent helpers shared by every OpenAI-family wire protocol.
 */
import { LlmError } from '../../core/errors'
import { FinishReason } from '../../core/types'
import { classifyByHttpStatus, classifyUnknown } from '../errorClassification'
import type { ClassifiedError } from '../types'

/** Tool-call arguments that are not valid JSON are surfaced raw, never dropped. */
export function parseArguments(argsString: string): Record<string, unknown> {
  try {
    return JSON.parse(argsString)
  } catch {
    return { _raw: argsString }
  }
}

/** Usage counts only when both counters arrived as non-negative integers. */
export function isUsageReported(inputTokens: unknown, outputTokens: unknown): boolean {
  return (
    Number.isInteger(inputTokens) &&
    (inputTokens as number) >= 0 &&
    Number.isInteger(outputTokens) &&
    (outputTokens as number) >= 0
  )
}

export function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return FinishReason.Stop
    case 'length':
      return FinishReason.Length
    case 'tool_calls':
      return FinishReason.ToolUse
    case 'content_filter':
      return FinishReason.ContentFilter
    default:
      return FinishReason.Unknown
  }
}

/**
 * An `LlmError` was already classified by the code that threw it (a protocol
 * error raised after a 2xx); re-deriving it from a missing HTTP status would
 * turn it into a retryable unknown. Otherwise endpoint-native codes win over
 * the HTTP status: some third parties report billing inside a 429, which the
 * status alone would treat as retryable.
 */
export function classifyFamilyError(
  err: unknown,
  endpointClassify: ((err: unknown) => ClassifiedError | null) | null
): ClassifiedError {
  if (err instanceof LlmError) {
    return {
      code: err.code as ClassifiedError['code'],
      retryable: err.retryable,
      message: err.message,
      httpStatus: err.httpStatus,
      providerCode: err.providerCode,
    }
  }
  return endpointClassify?.(err) ?? classifyByHttpStatus(err) ?? classifyUnknown(err)
}
