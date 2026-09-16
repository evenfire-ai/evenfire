export type SafeUsage = { inputTokens?: number; outputTokens?: number }

export function parseSafeUsage(input: unknown): SafeUsage | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const row = input as Record<string, unknown>
  const inputTokens = asNonNegativeInt(row.input_tokens ?? row.inputTokens ?? row.prompt_tokens)
  const outputTokens = asNonNegativeInt(row.output_tokens ?? row.outputTokens ?? row.completion_tokens)
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  const usage: SafeUsage = {}
  if (inputTokens !== undefined) usage.inputTokens = inputTokens
  if (outputTokens !== undefined) usage.outputTokens = outputTokens
  return usage
}

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return undefined
  }
  return value
}
