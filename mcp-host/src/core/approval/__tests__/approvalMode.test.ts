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

/** A session owner. No snapshot in these readers sets a policy that limits one. */
const OWNER = 'session-owner'

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
    expect(
      readChannelCap(snap({ email: { enabled: true, allowModeChange: true } }), 'email', OWNER)
    ).toBe('allow_all')
    expect(readChannelCap(snap({ email: { enabled: true } }), 'email', OWNER)).toBe('manual')
    expect(
      readChannelCap(snap({ email: { enabled: true, allowModeChange: false } }), 'email', OWNER)
    ).toBe('manual')
    expect(
      readChannelCap(snap({ teams: { enabled: true, allowModeChange: true } }), 'teams', OWNER)
    ).toBe('allow_all')
    expect(readChannelCap(snap({ teams: { enabled: true } }), 'teams', OWNER)).toBe('allow_all')
    expect(
      readChannelCap(snap({ teams: { enabled: true, allowModeChange: false } }), 'teams', OWNER)
    ).toBe('manual')
    expect(readChannelCap(snap(null), 'telegram', OWNER)).toBe('manual')
    expect(readChannelCap(snap({}), undefined, OWNER)).toBe('manual')
    expect(readChannelCap(snap({}), 'rpc', OWNER)).toBe('allow_all')
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
    expect(readChannelCap(rawSnap(approval), channelType, OWNER)).toBe(expected)
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
    expect(readChannelCap(rawSnap(approval), channelType, OWNER)).toBe('manual')
  })
})

type MessagingChannel = 'telegram' | 'slack' | 'teams' | 'email'

const POLICY_CHANNELS: readonly MessagingChannel[] = ['telegram', 'slack', 'teams', 'email']

/** Each approver entry is the sender id that channel reports, which is the session owner. */
const APPROVER: Record<MessagingChannel, string> = {
  telegram: '111111111',
  slack: 'U0APPROVER',
  teams: '29:approver-id',
  email: 'approver@example.test',
}

const NON_APPROVER: Record<MessagingChannel, string> = {
  telegram: '222222222',
  slack: 'U0OTHER',
  teams: '29:other-id',
  email: 'other@example.test',
}

function approverChannels(): Record<string, unknown> {
  return Object.fromEntries(
    POLICY_CHANNELS.map(channel => [
      channel,
      { enabled: true, approvers: [APPROVER[channel]], allowModeChange: true },
    ])
  )
}

/** `effective` and `hostSpec` are the same object, as a Host CR publishes them. */
function policySnap(
  defaultPolicy: unknown,
  channels: unknown = approverChannels()
): ApprovalConfigSnapshot {
  const approval = {
    defaultPolicy,
    modeCeiling: 'allow_all',
    channels,
  } as unknown as ApprovalConfig
  return { effective: approval, hostSpec: approval }
}

describe('approver policy in the channel cap', () => {
  it.each(POLICY_CHANNELS)(
    'cli_only caps every %s session at manual, a listed approver included',
    channel => {
      // Control: the same channels with no policy check leave the switch on.
      expect(readChannelCap(policySnap('channel_users'), channel, NON_APPROVER[channel])).toBe(
        'allow_all'
      )

      expect(readChannelCap(policySnap('cli_only'), channel, APPROVER[channel])).toBe('manual')
      expect(readChannelCap(policySnap('cli_only'), channel, NON_APPROVER[channel])).toBe('manual')
    }
  )

  it('cli_only leaves an rpc session at allow_all', () => {
    expect(readChannelCap(policySnap('cli_only'), 'telegram', APPROVER.telegram)).toBe('manual')
    expect(readChannelCap(policySnap('cli_only'), 'rpc', 'desktop-user')).toBe('allow_all')
    expect(readChannelCap(policySnap('designated_approvers'), 'rpc', 'desktop-user')).toBe(
      'allow_all'
    )
  })

  it.each(POLICY_CHANNELS)(
    'designated_approvers keeps a listed %s owner at allow_all and caps any other owner',
    channel => {
      const snap = policySnap('designated_approvers')
      expect(readChannelCap(snap, channel, APPROVER[channel])).toBe('allow_all')
      expect(readChannelCap(snap, channel, NON_APPROVER[channel])).toBe('manual')
    }
  )

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['channel_users', 'channel_users'],
  ])('policy %s adds nothing to the switch', (_label, policy) => {
    expect(readChannelCap(policySnap('designated_approvers'), 'slack', NON_APPROVER.slack)).toBe(
      'manual'
    )
    expect(readChannelCap(policySnap(policy), 'slack', NON_APPROVER.slack)).toBe('allow_all')
    expect(readChannelCap(policySnap(policy), 'email', NON_APPROVER.email)).toBe('allow_all')
  })

  it('designated_approvers caps a listed approver whose channel block sets enabled: false', () => {
    const channels = {
      telegram: { enabled: false, approvers: [APPROVER.telegram], allowModeChange: true },
    }
    expect(readChannelCap(policySnap('designated_approvers'), 'telegram', APPROVER.telegram)).toBe(
      'allow_all'
    )
    expect(
      readChannelCap(policySnap('designated_approvers', channels), 'telegram', APPROVER.telegram)
    ).toBe('manual')
  })

  it('designated_approvers reads an absent enabled as enabled', () => {
    const channels = { telegram: { approvers: [APPROVER.telegram], allowModeChange: true } }
    const snap = policySnap('designated_approvers', channels)
    expect(readChannelCap(snap, 'telegram', APPROVER.telegram)).toBe('allow_all')
    expect(readChannelCap(snap, 'telegram', NON_APPROVER.telegram)).toBe('manual')
  })

  it('designated_approvers caps every Teams owner when the Host lists no Teams approvers', () => {
    const channels = {
      telegram: { enabled: true, approvers: [APPROVER.telegram], allowModeChange: true },
    }
    const snap = policySnap('designated_approvers', channels)
    expect(readChannelCap(snap, 'telegram', APPROVER.telegram)).toBe('allow_all')
    expect(readChannelCap(snap, 'teams', APPROVER.teams)).toBe('manual')
  })

  // Email approver matching is exact, case included, by decision.
  it('designated_approvers caps an email owner whose case differs from the listed approver', () => {
    const snap = policySnap('designated_approvers')
    const owner = 'Approver@example.test'
    expect(owner.toLowerCase()).toBe(APPROVER.email)
    expect(readChannelCap(snap, 'email', APPROVER.email)).toBe('allow_all')
    expect(readChannelCap(snap, 'email', owner)).toBe('manual')
  })

  it.each([
    ['an unknown string', 'admins_only'],
    ['a different case', 'CLI_ONLY'],
    ['a non-string', 7],
  ])('an invalid policy (%s) caps every messaging owner, a listed approver included', (_l, p) => {
    for (const channel of POLICY_CHANNELS) {
      expect(readChannelCap(policySnap(p), channel, APPROVER[channel])).toBe('manual')
    }
    expect(readChannelCap(policySnap(p), 'rpc', 'desktop-user')).toBe('allow_all')
  })

  it('designated_approvers caps without throwing when channels is absent or malformed', () => {
    const absent = { defaultPolicy: 'designated_approvers' } as unknown as ApprovalConfig
    expect(
      readChannelCap({ effective: absent, hostSpec: undefined }, 'telegram', APPROVER.telegram)
    ).toBe('manual')
    const stringApprovers = {
      telegram: { enabled: true, approvers: `${APPROVER.telegram}9`, allowModeChange: true },
    }
    expect(
      readChannelCap(
        policySnap('designated_approvers', stringApprovers),
        'telegram',
        APPROVER.telegram
      )
    ).toBe('manual')
  })

  it('designated_approvers caps an empty or unknown owner, even when approvers lists an empty id', () => {
    const channels = { telegram: { enabled: true, approvers: [''], allowModeChange: true } }
    const snap = policySnap('designated_approvers', channels)
    expect(readChannelCap(snap, 'telegram', '')).toBe('manual')
    expect(readChannelCap(snap, 'telegram', undefined)).toBe('manual')
    expect(readChannelCap(policySnap('channel_users', channels), 'telegram', undefined)).toBe(
      'allow_all'
    )
  })

  it('reads the policy from the policy in force and the switch from the Host spec', () => {
    const configMap = policySnap('designated_approvers').effective
    // A ConfigMap policy with no Host spec: the switch keeps its default.
    expect(
      readChannelCap({ effective: configMap, hostSpec: undefined }, 'telegram', APPROVER.telegram)
    ).toBe('allow_all')
    expect(
      readChannelCap(
        { effective: configMap, hostSpec: undefined },
        'telegram',
        NON_APPROVER.telegram
      )
    ).toBe('manual')
    // A Host spec policy that is not the one in force adds nothing.
    expect(
      readChannelCap(
        { effective: policySnap('channel_users').effective, hostSpec: configMap },
        'telegram',
        NON_APPROVER.telegram
      )
    ).toBe('allow_all')
  })

  it('keeps the switch first: allowModeChange false caps a listed approver too', () => {
    const channels = {
      slack: { enabled: true, approvers: [APPROVER.slack], allowModeChange: false },
    }
    expect(
      readChannelCap(policySnap('designated_approvers', channels), 'slack', APPROVER.slack)
    ).toBe('manual')
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
