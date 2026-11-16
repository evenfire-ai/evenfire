import { serializeOutputForStatus } from '@clerum/workflow-runtime-core'

export interface StatusOutputPreview {
  output: string
  outputTruncated: boolean
  outputLength: number
  outputPreviewMaxChars: number
}

/** What the client says about the output before it cut it. */
export interface ReportedOutput {
  outputLength?: unknown
  outputTruncated?: unknown
}

/**
 * `reported` is honoured only when it marks the output as truncated and
 * declares a length at least as long as what WRC received, so a client can
 * report a longer original output, never a shorter one, and cannot mark an
 * output WRC cut as complete. The output counts as cut by the client only when
 * that length is longer than what WRC received (`outputCutByCoordinator`).
 */
export function buildStatusOutputPreview(
  value: unknown,
  maxChars: number,
  reported?: ReportedOutput
): StatusOutputPreview {
  const serialized = serializeOutputForStatus(value)
  const localLength = serialized.length
  const localTruncated = localLength > maxChars
  const declaredLength = declaredOriginalLength(reported)
  const reportedLength =
    declaredLength !== undefined && declaredLength >= localLength ? declaredLength : undefined

  const output = localTruncated ? serialized.slice(0, maxChars) : serialized
  const outputTruncated =
    localTruncated || (reportedLength !== undefined && reportedLength > localLength)
  return {
    output,
    outputTruncated,
    outputLength: reportedLength ?? localLength,
    // The limit that produced this preview: WRC's, or the shorter length the
    // coordinator already cut the output to.
    outputPreviewMaxChars: outputTruncated ? output.length : maxChars,
  }
}

/**
 * True when the client cut `value` before sending it, as `buildStatusOutputPreview`
 * accepts it: the report marks the output as truncated and declares a longer
 * original length. `value` is then a prefix, so its artifacts are the ones the
 * client sends in `outputArtifacts`, not the ones the prefix may parse to.
 */
export function outputCutByCoordinator(value: unknown, reported: ReportedOutput): boolean {
  const declaredLength = declaredOriginalLength(reported)
  if (declaredLength === undefined || value === undefined || value === null) return false
  return declaredLength > serializeOutputForStatus(value).length
}

function declaredOriginalLength(reported: ReportedOutput | undefined): number | undefined {
  return reported?.outputTruncated === true &&
    typeof reported.outputLength === 'number' &&
    Number.isSafeInteger(reported.outputLength)
    ? reported.outputLength
    : undefined
}
