/*
 * Runs inside the deployed mcp-host image as a fresh Node process. It verifies
 * the shipped cron_manage policy artifacts for the requested env mode; the
 * live-process CronScheduler -> heartbeat supplier is covered by unit tests.
 */
const { CronScheduler } = require('/app/dist/agent/cronScheduler')
const {
  CronManageTool,
  STATELESS_CRON_FORBIDDEN_MESSAGE,
  STATELESS_CRON_NOTICE,
} = require('/app/dist/core/tools/cronManage')

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

;(async () => {
  const expectedAllow = process.argv[2] === 'true'
  const scheduler = new CronScheduler(
    { enqueue: () => true },
    { statelessLifecycle: true, allowEnabledJobs: expectedAllow }
  )
  const tool = new CronManageTool(scheduler, undefined, true, expectedAllow)

  assert(tool.name() === 'cron_manage', 'cron_manage tool name changed')
  assert(tool.requiresApproval() === expectedAllow, `requiresApproval expected ${expectedAllow}`)

  const created = await tool.execute({
    action: 'create',
    name: 'e2e-deployed-cron-policy',
    schedule: '0 3 1 1 *',
    task: 'reply tick',
  })

  if (expectedAllow) {
    assert(created.is_error === false, 'allow mode create should succeed once the HITL gate passes')
    assert(created.content.includes(STATELESS_CRON_NOTICE), 'allow mode missing stateless notice')
    assert(scheduler.hasEnabledJobs() === true, 'allow mode create should leave enabled schedule')
    return
  }

  assert(created.is_error === true, 'forbid mode create should fail server-side')
  assert(
    created.content.includes(STATELESS_CRON_FORBIDDEN_MESSAGE),
    'forbid mode create missing disabled message'
  )
  assert(scheduler.hasEnabledJobs() === false, 'forbid mode create left enabled schedule')

  const existing = scheduler.createJob('e2e-existing-disabled', '0 4 1 1 *', 'reply tick')
  assert(existing && existing.enabled === false, 'forbid mode scheduler should keep jobs disabled')

  const enabled = await tool.execute({ action: 'enable', jobId: existing.id })
  assert(enabled.is_error === true, 'forbid mode enable should fail server-side')
  assert(
    enabled.content.includes(STATELESS_CRON_FORBIDDEN_MESSAGE),
    'forbid mode enable missing disabled message'
  )
  assert(scheduler.hasEnabledJobs() === false, 'forbid mode enable left active schedule')
})().catch(err => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
