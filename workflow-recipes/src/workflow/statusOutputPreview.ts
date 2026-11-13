import { serializeOutputForStatus } from '@clerum/workflow-runtime-core'

export interface StatusOutputPreview {
  output: string
  outputTruncated: boolean
  outputLength: number
  outputPreviewMaxChars: number
}

/**
 * `reported` is what the client says about the output before it cut it. It is
 * honoured only when it marks the output as truncated and declares a length at
 * least as long as what WRC received, so a client can report a longer original
 * output, never a shorter one, and cannot mark an output WRC cut as complete.
 */
export function buildStatusOutputPreview(
  value: unknown,
  maxChars: number,
  reported?: { outputLength?: unknown; outputTruncated?: unknown }
): StatusOutputPreview {
  const serialized = serializeOutputForStatus(value)
  const localLength = serialized.length
  const localTruncated = localLength > maxChars
  const reportedLength =
    reported?.outputTruncated === true &&
    typeof reported.outputLength === 'number' &&
    Number.isSafeInteger(reported.outputLength) &&
    reported.outputLength >= localLength
      ? reported.outputLength
      : undefined

  return {
    output: localTruncated ? serialized.slice(0, maxChars) : serialized,
    outputTruncated:
      localTruncated || (reportedLength !== undefined && reportedLength > localLength),
    outputLength: reportedLength ?? localLength,
    outputPreviewMaxChars: maxChars,
  }
}
