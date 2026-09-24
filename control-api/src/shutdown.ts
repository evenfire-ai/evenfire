export type ShutdownStep = {
  name: string
  run: () => void | Promise<void>
}

export type ShutdownResult = {
  errors: Array<{ name: string; error: unknown }>
  timedOut: boolean
}

export const CONTROL_API_SHUTDOWN_STEP_NAMES = [
  'http-server-and-streams',
  'approval-expiry-cron',
  'plugin-sdk-maintenance-cron',
  'rate-limit-cleanup',
  'revoked-token-cleanup',
  'usage-rollup-cron',
  'usage-retention-cron',
  'budget-reservation-sweep',
  'approval-archive-cron',
  'llm-catalog-sync-cron',
  'subscription-catalog-sync-cron',
  'registry-pull-secret-cron',
  'workflow-runs-archive-cron',
  'workflow-schedule-worker',
  'workflow-approval-notification-worker',
  'workflow-approval-trace-projector',
  'entity-change-dispatcher',
  'core-database-pool',
  'rate-limit-database-pool',
  'trace-database-pools',
] as const

export type ControlApiShutdownStepName = (typeof CONTROL_API_SHUTDOWN_STEP_NAMES)[number]

export function createControlApiShutdownSteps(
  actions: Record<ControlApiShutdownStepName, () => void | Promise<void>>
): ShutdownStep[] {
  return CONTROL_API_SHUTDOWN_STEP_NAMES.map(name => ({ name, run: actions[name] }))
}

/** Run every cleanup step in order under one shared deadline. */
export async function runShutdownSteps(
  steps: readonly ShutdownStep[],
  timeoutMs: number
): Promise<ShutdownResult> {
  const errors: ShutdownResult['errors'] = []
  let timeout: NodeJS.Timeout | undefined
  const cleanup = (async () => {
    for (const step of steps) {
      try {
        await step.run()
      } catch (error) {
        errors.push({ name: step.name, error })
      }
    }
  })()
  const completed = await Promise.race([
    cleanup.then(() => true),
    new Promise<false>(resolve => {
      timeout = setTimeout(() => resolve(false), timeoutMs)
      timeout.unref?.()
    }),
  ])
  if (timeout) clearTimeout(timeout)
  return { errors, timedOut: !completed }
}

/** Coalesce repeated signals/fatal paths onto one in-flight shutdown. */
export function createShutdownHandler(run: () => Promise<void>): () => Promise<void> {
  let shutdown: Promise<void> | null = null
  return () => {
    shutdown ??= run()
    return shutdown
  }
}
