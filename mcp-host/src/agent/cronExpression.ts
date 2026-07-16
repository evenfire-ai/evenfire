import { CronExpressionParser } from 'cron-parser'

export function parseNextRun(schedule: string, from: Date = new Date()): Date | null {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) {
    console.error(`[Cron] Invalid cron expression: ${schedule}`)
    return null
  }
  try {
    const interval = CronExpressionParser.parse(schedule, { currentDate: from })
    return interval.next().toDate()
  } catch (error) {
    console.error(`[Cron] Invalid cron expression: ${schedule}`, error)
    return null
  }
}
