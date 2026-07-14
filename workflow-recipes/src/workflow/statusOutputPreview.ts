export interface StatusOutputPreview {
  output: string
  outputTruncated: boolean
  outputLength: number
  outputPreviewMaxChars: number
}

export function buildStatusOutputPreview(value: unknown, maxChars: number): StatusOutputPreview {
  const serialized = serializeStatusOutput(value)
  const outputLength = serialized.length
  const outputTruncated = outputLength > maxChars

  return {
    output: outputTruncated ? serialized.slice(0, maxChars) : serialized,
    outputTruncated,
    outputLength,
    outputPreviewMaxChars: maxChars,
  }
}

function serializeStatusOutput(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'

  const seen = new WeakSet<object>()
  try {
    const serialized = JSON.stringify(value, (_key, nested) => {
      if (typeof nested === 'object' && nested !== null) {
        if (seen.has(nested)) return '[Circular]'
        seen.add(nested)
      }
      return nested
    })
    return serialized ?? String(value)
  } catch {
    return String(value)
  }
}
