/** A cron job a test created, with the user whose session owns it. */
export type CronJobRef = readonly [jobId: string, userId: string]

/**
 * Run `body` with a list the test fills with each job once the job's Created
 * line has been seen, then delete every listed job, trying each one even when
 * an earlier delete fails.
 *
 * The cleanup is best effort. A job whose create did not show its Created line
 * in time is never listed, and a test timeout abandons the body and this
 * cleanup together; in both cases the job stays in the scheduler. Cron jobs
 * live only in the chatllm pod's memory, so restarting deploy/chatllm removes
 * them.
 *
 * A cleanup failure never hides a body failure: when both fail, the thrown
 * AggregateError carries the body error first and as its cause, so the test
 * report shows the real failure and its stack before the cleanup error.
 */
export async function withJobCleanup<T>(
  body: (jobs: CronJobRef[]) => Promise<T>,
  deleteJob: (jobId: string, userId: string) => Promise<unknown>
): Promise<T> {
  const jobs: CronJobRef[] = []
  let bodyFailed = false
  let bodyError: unknown
  let result: T | undefined
  try {
    result = await body(jobs)
  } catch (err) {
    bodyFailed = true
    bodyError = err
  }

  const failures: string[] = []
  for (const [jobId, userId] of jobs) {
    try {
      await deleteJob(jobId, userId)
    } catch (err) {
      failures.push(`${jobId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const cleanupError =
    failures.length > 0
      ? new Error(
          'Cron job cleanup failed; these jobs stay in memory until chatllm restarts ' +
            `(kubectl -n mcp-host rollout restart deploy/chatllm):\n${failures.join('\n')}`
        )
      : undefined

  if (bodyFailed) {
    if (cleanupError) {
      const bodyMessage = bodyError instanceof Error ? bodyError.message : String(bodyError)
      throw new AggregateError(
        [bodyError, cleanupError],
        `${bodyMessage}\n\n${cleanupError.message}`,
        { cause: bodyError }
      )
    }
    throw bodyError
  }
  if (cleanupError) throw cleanupError
  return result as T
}
