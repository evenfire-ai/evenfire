import { describe, expect, it } from 'vitest'
import { ApprovalResolver } from '../approvalResolver'
import type { ApprovalConfig } from '../approvalTypes'

describe('ApprovalResolver', () => {
  const resolver = new ApprovalResolver()

  it('should block channel users when policy is cli_only', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'cli_only',
      channels: {
        telegram: { enabled: true, approvers: ['user-1'] },
      },
    }

    expect(resolver.canUserApprove('user-1', 'telegram', 'chan-1', config)).toBe(false)
  })

  it('should allow any user when policy is channel_users', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'channel_users',
      channels: {
        telegram: { enabled: true },
      },
    }

    expect(resolver.canUserApprove('random-user', 'telegram', 'chan-1', config)).toBe(true)
  })

  it('should allow listed user when policy is designated_approvers', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'designated_approvers',
      channels: {
        telegram: { enabled: true, approvers: ['user-1', 'user-2'] },
      },
    }

    expect(resolver.canUserApprove('user-1', 'telegram', 'chan-1', config)).toBe(true)
    expect(resolver.canUserApprove('user-2', 'telegram', 'chan-1', config)).toBe(true)
  })

  it('should block unlisted user when policy is designated_approvers', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'designated_approvers',
      channels: {
        telegram: { enabled: true, approvers: ['user-1'] },
      },
    }

    expect(resolver.canUserApprove('user-999', 'telegram', 'chan-1', config)).toBe(false)
  })

  it('should block all users when channel is disabled', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'channel_users',
      channels: {
        telegram: { enabled: false },
      },
    }

    expect(resolver.canUserApprove('user-1', 'telegram', 'chan-1', config)).toBe(false)
  })

  it('should treat missing channel config as enabled (opt-out model)', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'channel_users',
      channels: {},
    }

    // Telegram not listed in channels -> treated as enabled
    expect(resolver.canUserApprove('user-1', 'telegram', 'chan-1', config)).toBe(true)
  })

  it('should return false when no approval config is provided (default cli_only)', () => {
    expect(resolver.canUserApprove('user-1', 'telegram', 'chan-1', undefined)).toBe(false)
  })

  it('should block all when designated_approvers with empty approvers list', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'designated_approvers',
      channels: {
        telegram: { enabled: true, approvers: [] },
      },
    }

    expect(resolver.canUserApprove('user-1', 'telegram', 'chan-1', config)).toBe(false)
  })

  it('should always allow CLI users (channelType undefined) when config exists', () => {
    const config: ApprovalConfig = {
      defaultPolicy: 'cli_only',
      channels: {},
    }

    // CLI users bypass all channel-level restrictions
    expect(resolver.canUserApprove('any-user', undefined, undefined, config)).toBe(true)
  })

  it('should deny CLI users when no config is provided', () => {
    // Even CLI users are denied without any config (safest default)
    expect(resolver.canUserApprove('any-user', undefined, undefined, undefined)).toBe(false)
  })
})
