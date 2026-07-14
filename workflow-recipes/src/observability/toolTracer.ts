/**
 * Tool call tracing for CRD status population.
 *
 * Populates status.steps[].toolsCalled[] with per-call records.
 * Truncates input/output at 1024 chars for CRD; full data goes to structured logs.
 *
 * Source of truth: STAGE-3-OBSERVABILITY-FINALIZATION.md §4.3
 */

export interface ToolTrace {
  toolName: string
  calledAt: string
  durationMs: number
  inputSummary: string
  outputSummary: string
  success: boolean
  errorMessage?: string
}

const DEFAULT_MAX_CHARS = 1024
const MAX_TOOLS_PER_STEP = 50

export function truncate(value: unknown, maxChars = DEFAULT_MAX_CHARS): string {
  if (value === null || value === undefined) return String(value)
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  if (serialized.length <= maxChars) return serialized
  const truncated = serialized.slice(0, maxChars)
  return `${truncated}...[truncated ${serialized.length - maxChars} chars]`
}

export function buildToolTraces(rawTraces: ToolTrace[]): {
  traces: ToolTrace[]
  truncated: boolean
} {
  const shouldTruncate = rawTraces.length > MAX_TOOLS_PER_STEP
  const traces = rawTraces.slice(0, MAX_TOOLS_PER_STEP).map(t => ({
    ...t,
    inputSummary: truncate(t.inputSummary),
    outputSummary: truncate(t.outputSummary),
  }))
  return { traces, truncated: shouldTruncate }
}
