/**
 * T1.5 — Spillover URI helpers.
 *
 * The on-wire URI format is `spillover://<task_id>/<tool_call_id>.json`. Both
 * segments are restricted to `[A-Za-z0-9_-]+` so the URI is always safe to
 * embed in path operations after validation. Parsing is conservative: any
 * deviation returns `null` (callers convert that into ApprovalExpired or 410
 * paths — never silently regenerate).
 */

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/

export interface ParsedSpilloverRef {
  taskId: string
  toolCallId: string
}

export function buildSpilloverRef(taskId: string, toolCallId: string): string {
  if (!SEGMENT_RE.test(taskId)) {
    throw new Error(`Invalid spillover taskId: ${JSON.stringify(taskId)}`)
  }
  if (!SEGMENT_RE.test(toolCallId)) {
    throw new Error(`Invalid spillover toolCallId: ${JSON.stringify(toolCallId)}`)
  }
  return `spillover://${taskId}/${toolCallId}.json`
}

export function parseSpilloverRef(ref: unknown): ParsedSpilloverRef | null {
  if (typeof ref !== 'string') return null
  if (!ref.startsWith('spillover://')) return null
  const rest = ref.slice('spillover://'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const taskId = rest.slice(0, slash)
  const tail = rest.slice(slash + 1)
  if (!tail.endsWith('.json')) return null
  const toolCallId = tail.slice(0, -'.json'.length)
  if (!SEGMENT_RE.test(taskId) || !SEGMENT_RE.test(toolCallId)) return null
  return { taskId, toolCallId }
}
