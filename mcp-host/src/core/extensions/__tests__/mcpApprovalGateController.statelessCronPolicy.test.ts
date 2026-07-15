import { afterEach, describe, expect, it, vi } from 'vitest'
import { CronScheduler } from '../../../agent/cronScheduler'
import { MessageQueue } from '../../../queue/messageQueue'
import { STATELESS_ALLOW_CRON_MANAGE_ENV } from '../../../statelessCronPolicy'
import type { NativeToolConfig } from '../../interfaces'
import { NativeToolRegistry } from '../../tools/nativeToolRegistry'
import {
  STATELESS_CRON_APPROVAL_PROMPT,
  UnifiedApprovalGateController,
} from '../mcpApprovalGateController'

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

const waivingConfig = {
  defaultPolicy: 'channel_users' as const,
  channels: {},
  tools: { cron_manage: false },
}

function buildRegistry(): NativeToolRegistry {
  const queue = new MessageQueue()
  vi.spyOn(queue, 'enqueue').mockImplementation(() => true)
  const scheduler = new CronScheduler(queue, { statelessLifecycle: true })
  return new NativeToolRegistry(config, 'test-conv', scheduler)
}

describe('UnifiedApprovalGateController — stateless cron policy', () => {
  const originalAllow = process.env[STATELESS_ALLOW_CRON_MANAGE_ENV]

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalAllow === undefined) delete process.env[STATELESS_ALLOW_CRON_MANAGE_ENV]
    else process.env[STATELESS_ALLOW_CRON_MANAGE_ENV] = originalAllow
  })

  it('does not open HITL for cron_manage create/enable in default-forbid mode', () => {
    delete process.env[STATELESS_ALLOW_CRON_MANAGE_ENV]
    const controller = new UnifiedApprovalGateController(
      buildRegistry(),
      waivingConfig,
      undefined,
      {
        statelessLifecycle: true,
      }
    )

    expect(controller.beforeTool('cron_manage', { action: 'create' })).toBe('proceed')
    expect(controller.beforeTool('cron_manage', { action: 'enable' })).toBe('proceed')
  })

  it('keeps the non-waivable stateless HITL gate when cron management is explicitly allowed', () => {
    process.env[STATELESS_ALLOW_CRON_MANAGE_ENV] = 'true'
    const controller = new UnifiedApprovalGateController(
      buildRegistry(),
      waivingConfig,
      undefined,
      {
        statelessLifecycle: true,
      }
    )

    const result = controller.beforeTool('cron_manage', { action: 'create' })

    expect((result as any).type).toBe('suspend')
    expect((result as any).approval.tool_name).toBe('cron_manage')
    expect((result as any).approval.description).toBe(STATELESS_CRON_APPROVAL_PROMPT)
  })
})
