import { describe, expect, it } from 'vitest'
import type { ApprovalConfig } from '../../extensions/approvalTypes'
import {
  type ApprovalConfigSnapshot,
  effectiveApprovalMode,
  normalizeApprovalMode,
  parseApprovalModeCommand,
  readChannelCap,
  readModeCeiling,
} from '../approvalMode'

describe('approval mode readers', () => {
  const x: ApprovalConfig = { defaultPolicy: 'cli_only', channels: {} }

  function snap(channels: ApprovalConfig['channels'] | null): ApprovalConfigSnapshot {
    return {
      effective: { defaultPolicy: 'channel_users', channels: {} },
      hostSpec: {
        defaultPolicy: 'cli_only',
        channels: channels === null ? (null as unknown as ApprovalConfig['channels']) : channels,
      },
    }
  }

  it('takes the minimum of stored, ceiling and cap, and reads host spec only', () => {
    const modes = ['manual', 'auto', 'allow_all'] as const
    const rank = { manual: 0, auto: 1, allow_all: 2 }
    for (const s of modes)
      for (const c of modes)
        for (const k of modes)
          expect(effectiveApprovalMode(s, c, k)).toBe(
            [s, c, k].sort((a, b) => rank[a] - rank[b])[0]
          )
    expect(normalizeApprovalMode('yolo')).toBe('manual')
    const env: ApprovalConfig = {
      defaultPolicy: 'channel_users',
      channels: {},
      modeCeiling: 'allow_all',
    }
    expect(readModeCeiling({ effective: env, hostSpec: undefined })).toBe('manual') // env ignored
    expect(readModeCeiling({ effective: x, hostSpec: { ...x, modeCeiling: 'allow_all' } })).toBe(
      'allow_all'
    )
    expect(readChannelCap(snap({ email: { enabled: true, allowModeChange: true } }), 'email')).toBe(
      'allow_all'
    )
    expect(readChannelCap(snap({ email: { enabled: true } }), 'email')).toBe('manual')
    expect(readChannelCap(snap({ teams: { enabled: true, allowModeChange: true } }), 'teams')).toBe(
      'manual'
    )
    expect(readChannelCap(snap(null), 'telegram')).toBe('manual')
    expect(readChannelCap(snap({}), undefined)).toBe('manual')
    expect(readChannelCap(snap({}), 'rpc')).toBe('allow_all')
    expect(parseApprovalModeCommand('  Approval-Mode allow-all ')).toBe('allow_all')
    expect(parseApprovalModeCommand('please approval-mode auto')).toBeNull()
  })
})
