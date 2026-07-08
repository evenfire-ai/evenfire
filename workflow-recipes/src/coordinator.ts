import { registry } from './metrics'
import { startCoordinatorHealthServer } from './workflow/coordinatorHttpServer'
import { runWorkflowFromEnvironment } from './workflow/sdkRuntime'

let healthPhase = 'initializing'

async function main(): Promise<void> {
  console.log('[Coordinator] Starting workflow coordinator')
  const healthServer = startCoordinatorHealthServer({
    getPhase: () => healthPhase,
    metricsRegistry: registry,
  })
  let exitCode = 1

  try {
    healthPhase = 'running'
    const result = await runWorkflowFromEnvironment()
    healthPhase = result.workflowPhase
    exitCode = result.exitCode
    console.log(`[Coordinator] Execution complete: ${result.workflowPhase}`)
    if (result.failureReason) {
      console.error(`[Coordinator] Failure reason: ${result.failureReason}`)
    }
  } catch (err) {
    healthPhase = 'failed'
    console.error('[Coordinator] Fatal runtime error:', err)
  } finally {
    await new Promise<void>(resolve => {
      healthServer.close(() => resolve())
      setTimeout(resolve, 2000)
    })
  }

  process.exit(exitCode)
}

if (require.main === module) {
  main().catch(err => {
    console.error('[Coordinator] Fatal startup error:', err)
    process.exit(1)
  })
}
