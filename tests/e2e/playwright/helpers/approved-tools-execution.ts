// E2E_GUARDIAN_IPC_FLOW: assertions over read-only external fixture observations.
import { isDeepStrictEqual } from 'node:util'
import type { Evidence } from './approved-tools-scenarios'

export function toolExecutions(evidence: Evidence, tool: string): number {
  const count = evidence.executions?.[tool]
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error(`Missing physical execution count: ${tool}`)
  if (evidence.calls.filter(call => call.tool === tool).length !== count)
    throw new Error(`Physical execution records do not match count: ${tool}`)
  return count
}

/** The original tool ran once before the outage and stayed unchanged after Retry. */
export function assertConfirmedToolNotReexecuted(
  before: Evidence,
  kept: Evidence,
  after: Evidence,
  tool: string
): void {
  if (
    [kept, after].some(
      value => value.runId !== before.runId || value.catalogSize !== before.catalogSize
    )
  )
    throw new Error('Physical execution evidence scenario changed')
  const initial = toolExecutions(before, tool)
  const confirmed = toolExecutions(kept, tool)
  const continued = toolExecutions(after, tool)
  if (confirmed !== initial + 1)
    throw new Error(`Expected one confirmed physical execution before Retry: ${tool}`)
  if (continued !== confirmed)
    throw new Error(`Confirmed tool physically re-executed after Retry: ${tool}`)
  if (
    !isDeepStrictEqual(
      kept.calls.filter(call => call.tool === tool),
      after.calls.filter(call => call.tool === tool)
    )
  )
    throw new Error(`Confirmed physical execution records changed after Retry: ${tool}`)
}
