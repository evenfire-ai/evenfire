/**
 * Parser for the mcp-host cron scheduler's log lines (component "Cron").
 *
 * The cluster E2E timing tests read the chatllm pod log to learn when a job
 * was created, enabled, disabled, deleted or fired. The log gives the exact
 * fire time, which neither the LLM reply nor GET /v1/runtime/cron/results
 * carries.
 *
 * Two forms exist and both must parse, so that a run against an older image
 * fails on its assertions, not on the parser:
 * - structured: {"component":"Cron","jobId":"…","jobName":"…","msg":"Executing job",…}
 * - console:    {"component":"Cron","msg":"Executing job: <name> (<uuid>)",…}
 */

export type CronLogEvent = 'Created' | 'Enabled' | 'Disabled' | 'Executing' | 'Deleted'

export interface CronLogEntry {
  event: CronLogEvent
  jobId: string
  jobName: string
  at: number
}

const EVENT_RE = /^(Created|Enabled|Disabled|Executing|Deleted) job\b/
const LEGACY_JOB_RE = /job: (.*) \(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/

export function parseCronLogLines(text: string): CronLogEntry[] {
  const entries: CronLogEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      // A pod log also carries non-JSON output (runtime banners, stack
      // traces); those lines are not Cron events.
      continue
    }
    if (record.component !== 'Cron' || typeof record.msg !== 'string') continue
    const event = EVENT_RE.exec(record.msg)?.[1] as CronLogEvent | undefined
    if (!event) continue

    const legacy = LEGACY_JOB_RE.exec(record.msg)
    const jobId = typeof record.jobId === 'string' ? record.jobId : legacy?.[2]
    const jobName = typeof record.jobName === 'string' ? record.jobName : legacy?.[1]
    if (!jobId || jobName === undefined) {
      throw new Error(`Cron ${event} line without a job id or name: ${trimmed}`)
    }
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
    if (Number.isNaN(at)) throw new Error(`Cron ${event} line without a timestamp: ${trimmed}`)

    entries.push({ event, jobId, jobName, at })
  }
  return entries
}
