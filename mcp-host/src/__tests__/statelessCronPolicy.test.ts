import { describe, expect, it } from 'vitest'
import {
  StatelessCronPolicyError,
  assertStatelessCronPolicyConfig,
  statelessCronSchedulesAllowed,
} from '../statelessCronPolicy'

describe('stateless cron policy config', () => {
  it('keeps default-forbid valid without requiring approvals', () => {
    expect(() =>
      assertStatelessCronPolicyConfig({
        statelessLifecycle: true,
        allowCronManage: false,
        enableApproval: false,
      })
    ).not.toThrow()
  })

  it('allows explicit cron management on stateless hosts only when approvals are enabled', () => {
    expect(() =>
      assertStatelessCronPolicyConfig({
        statelessLifecycle: true,
        allowCronManage: true,
        enableApproval: true,
      })
    ).not.toThrow()
  })

  it('fails loud when explicit stateless cron management cannot be HITL-gated', () => {
    expect(() =>
      assertStatelessCronPolicyConfig({
        statelessLifecycle: true,
        allowCronManage: true,
        enableApproval: false,
      })
    ).toThrow(StatelessCronPolicyError)
  })

  it('leaves non-stateless hosts unchanged', () => {
    expect(() =>
      assertStatelessCronPolicyConfig({
        statelessLifecycle: false,
        allowCronManage: true,
        enableApproval: false,
      })
    ).not.toThrow()
    expect(statelessCronSchedulesAllowed(false)).toBe(true)
  })
})
