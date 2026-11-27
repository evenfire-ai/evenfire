import { describe, expect, it } from 'vitest'
import { parseCronLogLines } from './cronLog.js'

// Both fixtures are excerpts of real output: CronScheduler.createJob,
// enableJob, disableJob, enableJob, triggerJob and deleteJob, run once with
// the scheduler of this branch (structured logger) and once with the
// scheduler of b2ad4cc52 (console adapter), with the logger of
// mcp-host/src/logger.ts. triggerJob logs "Manually triggering job", which
// the parser skips, and then "Executing job", which it parses as Executing.
const STRUCTURED = [
  '{"component":"Cron","jobId":"197554f7-0a7c-4218-805c-2b0c96240c6a","jobName":"fixture-job","schedule":"*/1 * * * *","nextRun":"2026-11-26T18:23:00.000Z","timestamp":"2026-11-26T18:22:51.138Z","level":"info","msg":"Created job"}',
  '{"component":"Cron","jobId":"197554f7-0a7c-4218-805c-2b0c96240c6a","jobName":"fixture-job","timestamp":"2026-11-26T18:22:51.138Z","level":"info","msg":"Enabled job"}',
  '{"component":"Cron","jobId":"197554f7-0a7c-4218-805c-2b0c96240c6a","jobName":"fixture-job","timestamp":"2026-11-26T18:22:51.138Z","level":"info","msg":"Disabled job"}',
  '{"component":"Cron","jobId":"197554f7-0a7c-4218-805c-2b0c96240c6a","jobName":"fixture-job","timestamp":"2026-11-26T18:22:51.138Z","level":"info","msg":"Enabled job"}',
  '{"component":"Cron","jobId":"197554f7-0a7c-4218-805c-2b0c96240c6a","jobName":"fixture-job","timestamp":"2026-11-26T18:22:51.138Z","level":"info","msg":"Manually triggering job"}',
  '{"component":"Cron","jobId":"197554f7-0a7c-4218-805c-2b0c96240c6a","jobName":"fixture-job","timestamp":"2026-11-26T18:22:51.138Z","level":"info","msg":"Executing job"}',
  '{"component":"Cron","jobId":"197554f7-0a7c-4218-805c-2b0c96240c6a","jobName":"fixture-job","timestamp":"2026-11-26T18:22:51.138Z","level":"info","msg":"Deleted job"}',
].join('\n')

const CONSOLE = [
  '{"timestamp":"2026-11-26T18:22:51.139Z","level":"info","msg":"Created job: fixture-job (3f1fd703-9bee-4a3c-9f99-c88881ced8d2) - Schedule: */1 * * * *","component":"Cron"}',
  '{"timestamp":"2026-11-26T18:22:51.139Z","level":"info","msg":"Next run: 2026-11-26T18:23:00.000Z","component":"Cron"}',
  '{"timestamp":"2026-11-26T18:22:51.139Z","level":"info","msg":"Enabled job: fixture-job (3f1fd703-9bee-4a3c-9f99-c88881ced8d2)","component":"Cron"}',
  '{"timestamp":"2026-11-26T18:22:51.139Z","level":"info","msg":"Disabled job: fixture-job (3f1fd703-9bee-4a3c-9f99-c88881ced8d2)","component":"Cron"}',
  '{"timestamp":"2026-11-26T18:22:51.139Z","level":"info","msg":"Enabled job: fixture-job (3f1fd703-9bee-4a3c-9f99-c88881ced8d2)","component":"Cron"}',
  '{"timestamp":"2026-11-26T18:22:51.139Z","level":"info","msg":"Manually triggering job: fixture-job (3f1fd703-9bee-4a3c-9f99-c88881ced8d2)","component":"Cron"}',
  '{"timestamp":"2026-11-26T18:22:51.139Z","level":"info","msg":"Executing job: fixture-job (3f1fd703-9bee-4a3c-9f99-c88881ced8d2)","component":"Cron"}',
  '{"timestamp":"2026-11-26T18:22:51.139Z","level":"info","msg":"Deleted job: fixture-job (3f1fd703-9bee-4a3c-9f99-c88881ced8d2)","component":"Cron"}',
].join('\n')

const EVENTS = ['Created', 'Enabled', 'Disabled', 'Enabled', 'Executing', 'Deleted']

describe('parseCronLogLines', () => {
  it('reads the structured Cron lines', () => {
    const entries = parseCronLogLines(STRUCTURED)

    expect(entries.map(e => e.event)).toEqual(EVENTS)
    expect(new Set(entries.map(e => e.jobId))).toEqual(
      new Set(['197554f7-0a7c-4218-805c-2b0c96240c6a'])
    )
    expect(new Set(entries.map(e => e.jobName))).toEqual(new Set(['fixture-job']))
    expect(entries[0]!.at).toBe(Date.parse('2026-11-26T18:22:51.138Z'))
  })

  it('reads the console-form Cron lines of the pre-fix scheduler', () => {
    const entries = parseCronLogLines(CONSOLE)

    expect(entries.map(e => e.event)).toEqual(EVENTS)
    expect(new Set(entries.map(e => e.jobId))).toEqual(
      new Set(['3f1fd703-9bee-4a3c-9f99-c88881ced8d2'])
    )
    expect(new Set(entries.map(e => e.jobName))).toEqual(new Set(['fixture-job']))
    expect(entries[0]!.at).toBe(Date.parse('2026-11-26T18:22:51.139Z'))
  })

  it('skips non-JSON lines and other components, keeping the Cron lines around them', () => {
    const text = [
      'Node.js v24.22.1',
      '{"timestamp":"2026-11-26T18:22:50.000Z","level":"info","msg":"Executing job: other","component":"Main"}',
      STRUCTURED.split('\n')[5],
      '{not json',
    ].join('\n')

    expect(parseCronLogLines(text).map(e => e.event)).toEqual(['Executing'])
  })

  it('fails loudly on a Cron event line without a job id', () => {
    const line =
      '{"timestamp":"2026-11-26T18:22:51.139Z","level":"info","msg":"Executing job: fixture-job","component":"Cron"}'

    expect(() => parseCronLogLines(line)).toThrow(/without a job id/)
  })
})
