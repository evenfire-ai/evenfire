import { afterEach, describe, expect, it, vi } from 'vitest'
import { CronScheduler } from '../../../agent/cronScheduler'
import { MessageQueue } from '../../../queue/messageQueue'
import { STATELESS_ALLOW_CRON_MANAGE_ENV } from '../../../statelessCronPolicy'
import type { NativeToolConfig } from '../../interfaces'
import { NativeToolRegistry } from '../nativeToolRegistry'

const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 30000,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1048576,
  statelessLifecycle: true,
}

function buildRegistry(): NativeToolRegistry {
  const queue = new MessageQueue()
  vi.spyOn(queue, 'enqueue').mockImplementation(() => true)
  const scheduler = new CronScheduler(queue, { statelessLifecycle: true })
  return new NativeToolRegistry(config, 'test-conv', scheduler)
}

describe('NativeToolRegistry — stateless cron policy', () => {
  const originalAllow = process.env[STATELESS_ALLOW_CRON_MANAGE_ENV]

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalAllow === undefined) delete process.env[STATELESS_ALLOW_CRON_MANAGE_ENV]
    else process.env[STATELESS_ALLOW_CRON_MANAGE_ENV] = originalAllow
  })

  it('keeps cron_manage registered in default-forbid mode while rejecting schedule creation', async () => {
    delete process.env[STATELESS_ALLOW_CRON_MANAGE_ENV]

    const registry = buildRegistry()
    const tool = registry.get('cron_manage')
    const names = registry.listDefinitions().map(def => def.name)

    expect(names).toContain('cron_manage')
    expect(tool).not.toBeNull()
    expect(tool!.requiresApproval()).toBe(false)

    const output = await tool!.execute({
      action: 'create',
      name: 'daily',
      schedule: '0 0 * * *',
      task: 'do it',
    })
    expect(output.is_error).toBe(true)
    expect(output.content).toContain('cron_manage create/enable is disabled')
  })

  it('keeps cron_manage registered and approval-gated when stateless cron is explicitly allowed', () => {
    process.env[STATELESS_ALLOW_CRON_MANAGE_ENV] = 'true'

    const registry = buildRegistry()
    const tool = registry.get('cron_manage')
    const names = registry.listDefinitions().map(def => def.name)

    expect(names).toContain('cron_manage')
    expect(tool).not.toBeNull()
    expect(tool!.requiresApproval()).toBe(true)
  })
})
