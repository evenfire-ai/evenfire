import { describe, expect, it } from 'vitest'
import type { ApprovalConfig } from '../../extensions/approvalTypes'
import {
  type ApprovalConfigSnapshot,
  approvalModeConfigWarnings,
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
    expect(
      readChannelCap(snap({ email: { enabled: true, allowModeChange: false } }), 'email')
    ).toBe('manual')
    expect(readChannelCap(snap({ teams: { enabled: true, allowModeChange: true } }), 'teams')).toBe(
      'allow_all'
    )
    expect(readChannelCap(snap({ teams: { enabled: true } }), 'teams')).toBe('allow_all')
    expect(
      readChannelCap(snap({ teams: { enabled: true, allowModeChange: false } }), 'teams')
    ).toBe('manual')
    expect(readChannelCap(snap(null), 'telegram')).toBe('manual')
    expect(readChannelCap(snap({}), undefined)).toBe('manual')
    expect(readChannelCap(snap({}), 'rpc')).toBe('allow_all')
    expect(parseApprovalModeCommand('  Approval-Mode allow-all ')).toBe('allow_all')
    expect(parseApprovalModeCommand('please approval-mode auto')).toBeNull()
    expect(parseApprovalModeCommand('constructor')).toBeNull()
    expect(parseApprovalModeCommand('__proto__')).toBeNull()
  })

  // The raw value a dev-mode CLERUM_APPROVAL_CONFIG, or any path that skips the
  // apiserver schema, can carry. Cast through unknown on purpose.
  function rawSnap(approval: Record<string, unknown> | undefined): ApprovalConfigSnapshot {
    return { effective: undefined, hostSpec: approval as unknown as ApprovalConfig }
  }

  it.each([
    // [label, hostSpec.approval, channel type, expected cap]
    ['email with no field', { channels: { email: { enabled: true } } }, 'email', 'manual'],
    ['email with no block', { channels: {} }, 'email', 'manual'],
    ['email with no channels', {}, 'email', 'manual'],
    ['email with no approval', undefined, 'email', 'manual'],
    [
      'email explicit true',
      { channels: { email: { allowModeChange: true } } },
      'email',
      'allow_all',
    ],
    [
      'email explicit false',
      { channels: { email: { allowModeChange: false } } },
      'email',
      'manual',
    ],
    [
      'telegram with no field',
      { channels: { telegram: { enabled: true } } },
      'telegram',
      'allow_all',
    ],
    ['telegram with no block', { channels: {} }, 'telegram', 'allow_all'],
    ['slack with no channels', {}, 'slack', 'allow_all'],
    ['teams with no approval', undefined, 'teams', 'allow_all'],
  ] as const)('channel switch default: %s', (_label, approval, channelType, expected) => {
    expect(readChannelCap(rawSnap(approval), channelType)).toBe(expected)
  })

  it.each([
    ['channels null', { channels: null }, 'telegram'],
    ['channels array', { channels: [] }, 'slack'],
    ['channels string', { channels: 'telegram' }, 'teams'],
    ['entry false', { channels: { telegram: false } }, 'telegram'],
    ['entry string', { channels: { slack: 'off' } }, 'slack'],
    ['entry null', { channels: { teams: null } }, 'teams'],
    ['entry array', { channels: { telegram: [] } }, 'telegram'],
    ['field string "false"', { channels: { telegram: { allowModeChange: 'false' } } }, 'telegram'],
    ['field string "true"', { channels: { slack: { allowModeChange: 'true' } } }, 'slack'],
    ['field 0', { channels: { teams: { allowModeChange: 0 } } }, 'teams'],
    ['field 1', { channels: { telegram: { allowModeChange: 1 } } }, 'telegram'],
    ['field null', { channels: { telegram: { allowModeChange: null } } }, 'telegram'],
  ] as const)('malformed channel config reads manual: %s', (_label, approval, channelType) => {
    expect(readChannelCap(rawSnap(approval), channelType)).toBe('manual')
  })
})

describe('approval mode config warnings', () => {
  function warnings(approval: unknown): string[] {
    return approvalModeConfigWarnings(approval as ApprovalConfig | undefined).map(w => w.field)
  }

  it('names nothing for an absent or well-formed approval block', () => {
    expect(warnings(undefined)).toEqual([])
    expect(warnings({ defaultPolicy: 'cli_only', channels: {} })).toEqual([])
    expect(
      warnings({
        defaultPolicy: 'channel_users',
        modeCeiling: 'allow_all',
        channels: {
          telegram: { enabled: true, allowModeChange: false },
          email: { enabled: true },
          slack: { allowModeChange: true },
          teams: {},
        },
      })
    ).toEqual([])
  })

  it('names each malformed mode field', () => {
    expect(warnings({ modeCeiling: 'yolo', channels: {} })).toEqual(['modeCeiling'])
    expect(warnings({ modeCeiling: null, channels: {} })).toEqual(['modeCeiling'])
    expect(warnings({ channels: null })).toEqual(['channels'])
    expect(warnings({ channels: [] })).toEqual(['channels'])
    expect(
      warnings({
        channels: {
          telegram: false,
          email: { allowModeChange: 'false' },
          slack: { allowModeChange: null },
          teams: { allowModeChange: true },
        },
      })
    ).toEqual([
      'channels.telegram',
      'channels.email.allowModeChange',
      'channels.slack.allowModeChange',
    ])
  })
})
