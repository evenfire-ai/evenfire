import { describe, expect, it } from 'vitest'
import {
  readChannelSwitch,
  readModeCeiling,
} from '../../../mcp-host/src/core/approval/approvalMode'
import {
  approverPolicyIsInvalid,
  approverPolicyRefusal,
} from '../../../mcp-host/src/core/approval/approverPolicy'
import type { ApprovalConfig } from '../../../mcp-host/src/core/extensions/approvalTypes'
import { type EffectiveApproval, effectiveApproval, toolsEqual } from '../approvalEffective'

// The oracle is mcp-host's own readers, imported by relative path (no package
// imports in that graph, so control-ui CI needs no mcp-host install).

const CHANNELS = ['telegram', 'email', 'slack', 'teams'] as const
const OWNERS = ['123', ' 123'] as const

type Block = Record<string, unknown>

const TABLE: ReadonlyArray<readonly [string, Block | null | undefined]> = [
  ['undefined block', undefined],
  ['null block', null],
  ['empty block', {}],
  ['absent ceiling, auto policy open', { defaultPolicy: 'channel_users' }],
  ['bogus ceiling', { modeCeiling: 'bogus' }],
  ['ceiling auto', { modeCeiling: 'auto' }],
  ['ceiling allow_all', { modeCeiling: 'allow_all' }],
  ['missing channel (channels empty)', { channels: {} }],
  ['email without allowModeChange', { channels: { email: { enabled: true } } }],
  ['email allowModeChange true', { channels: { email: { allowModeChange: true } } }],
  ['telegram allowModeChange false', { channels: { telegram: { allowModeChange: false } } }],
  ['non-boolean allowModeChange', { channels: { slack: { allowModeChange: 'yes' } } }],
  ['channels not an object', { channels: 'x' }],
  ['channel entry not an object', { channels: { teams: 5 } }],
  ['policy null', { defaultPolicy: null }],
  ['policy empty string', { defaultPolicy: '' }],
  ['policy channel_users', { defaultPolicy: 'channel_users' }],
  ['policy weird', { defaultPolicy: 'weird' }],
  ['policy cli_only', { defaultPolicy: 'cli_only' }],
  [
    'designated, near-duplicate and spaced approvers',
    {
      defaultPolicy: 'designated_approvers',
      channels: { telegram: { enabled: true, approvers: [' 123', '123'] } },
    },
  ],
  [
    'designated, only spaced approver',
    {
      defaultPolicy: 'designated_approvers',
      channels: { telegram: { enabled: true, approvers: [' 123'] } },
    },
  ],
  [
    'designated, enabled absent',
    { defaultPolicy: 'designated_approvers', channels: { slack: { approvers: ['123'] } } },
  ],
  [
    'designated, enabled false',
    {
      defaultPolicy: 'designated_approvers',
      channels: { slack: { enabled: false, approvers: ['123'] } },
    },
  ],
  [
    'designated, non-boolean enabled',
    {
      defaultPolicy: 'designated_approvers',
      channels: { slack: { enabled: 'no', approvers: ['123'] } },
    },
  ],
  [
    'designated, approvers not a list',
    { defaultPolicy: 'designated_approvers', channels: { slack: { approvers: '123' } } },
  ],
  ['designated, channel missing', { defaultPolicy: 'designated_approvers', channels: {} }],
  ['designated, channels absent', { defaultPolicy: 'designated_approvers' }],
  [
    'open policy with enabled false',
    { defaultPolicy: 'channel_users', channels: { email: { enabled: false } } },
  ],
]

/** Whether the normalized block lets `owner` raise the mode on `channel`. */
function normalizedLetsRaise(
  eff: EffectiveApproval,
  channel: (typeof CHANNELS)[number],
  owner: string
): boolean {
  const ch = eff.channels[channel]
  if (!ch.allowModeChange) return false
  if (eff.policy === 'open') return true
  if (eff.policy === 'cli_only' || typeof eff.policy === 'object') return false
  return ch.enabled && owner !== '' && ch.approvers.includes(owner)
}

describe('effectiveApproval parity with mcp-host readers', () => {
  it.each(TABLE)('ceiling: %s', (_name, block) => {
    const cfg = (block ?? undefined) as ApprovalConfig | undefined
    expect(effectiveApproval(block).modeCeiling).toBe(
      readModeCeiling({ effective: cfg, hostSpec: cfg })
    )
  })

  it.each(TABLE)('channel switch: %s', (_name, block) => {
    const cfg = (block ?? undefined) as ApprovalConfig | undefined
    const eff = effectiveApproval(block)
    for (const channel of CHANNELS) {
      const oracle = readChannelSwitch({ effective: cfg, hostSpec: cfg }, channel)
      expect(eff.channels[channel].allowModeChange, channel).toBe(oracle === 'allow_all')
    }
  })

  it.each(TABLE)('policy and owner raise: %s', (_name, block) => {
    const cfg = (block ?? undefined) as ApprovalConfig | undefined
    const eff = effectiveApproval(block)
    // Every unknown policy is invalid for mcp-host exactly when it is { unknown }.
    expect(typeof eff.policy === 'object').toBe(approverPolicyIsInvalid(cfg))
    for (const channel of CHANNELS) {
      for (const owner of OWNERS) {
        const refusal = approverPolicyRefusal(cfg, { userId: owner, channelType: channel })
        const switchOn =
          readChannelSwitch({ effective: cfg, hostSpec: cfg }, channel) === 'allow_all'
        expect(normalizedLetsRaise(eff, channel, owner), `${channel} owner "${owner}"`).toBe(
          refusal === null && switchOn
        )
      }
    }
  })

  it('pins the channel default for an absent allowModeChange to the mcp-host reader', () => {
    const eff = effectiveApproval({})
    for (const channel of CHANNELS) {
      expect(eff.channels[channel].allowModeChange).toBe(
        readChannelSwitch(
          { effective: {} as ApprovalConfig, hostSpec: {} as ApprovalConfig },
          channel
        ) === 'allow_all'
      )
    }
    expect(eff.channels.email.allowModeChange).toBe(false)
    expect(eff.channels.telegram.allowModeChange).toBe(true)
  })
})

describe('effectiveApproval values', () => {
  it('keeps approvers as exact strings, deduplicated and sorted, never trimmed', () => {
    const eff = effectiveApproval({
      channels: { telegram: { approvers: ['b', ' 123', '123', 'b', '123 '] } },
    })
    expect(eff.channels.telegram.approvers).toEqual([' 123', '123', '123 ', 'b'])
  })

  it('an absent enabled is on and enabled false is off', () => {
    expect(effectiveApproval({}).channels.slack.enabled).toBe(true)
    expect(
      effectiveApproval({ channels: { slack: { enabled: false } } }).channels.slack.enabled
    ).toBe(false)
  })

  it('carries an unknown policy raw', () => {
    expect(effectiveApproval({ defaultPolicy: 'weird' }).policy).toEqual({ unknown: 'weird' })
  })

  it('maps absent, empty, null and channel_users policies to open', () => {
    for (const p of [undefined, null, '', 'channel_users']) {
      expect(effectiveApproval({ defaultPolicy: p }).policy).toBe('open')
    }
  })

  // No mcp-host parity here: the reader is `configuredShellClassifierModel`
  // (mcp-host/src/core/approval/shellClassifier.ts:15-17), but that file
  // imports the logger and usage modules, which pull npm packages control-ui's
  // CI does not install. This test restates its rule by hand (spec ruling 29).
  it('shell classifier model: absent or blank is null, otherwise the string', () => {
    expect(effectiveApproval({}).shellClassifierModel).toBeNull()
    expect(effectiveApproval({ shellClassifierModel: '  ' }).shellClassifierModel).toBeNull()
    expect(effectiveApproval({ shellClassifierModel: 'm1' }).shellClassifierModel).toBe('m1')
  })

  it('tools omit non-boolean entries and keep true and false', () => {
    const tools = effectiveApproval({ tools: { a: true, b: false, c: 'yes', d: null, e: 1 } }).tools
    expect(tools).toEqual({ a: true, b: false })
    expect(Object.keys(tools).sort()).toEqual(['a', 'b'])
  })

  it('tools keep three values: absent is not collapsed to a default', () => {
    expect(effectiveApproval({ tools: { a: true, b: false } }).tools).toEqual({ a: true, b: false })
    expect('c' in effectiveApproval({ tools: { a: true } }).tools).toBe(false)
  })
})

describe('toolsEqual', () => {
  it('treats {} and { x: false } as different', () => {
    expect(toolsEqual({}, { x: false })).toBe(false)
    expect(toolsEqual({ x: false }, {})).toBe(false)
  })

  it('treats absent and {} as equal, and compares booleans', () => {
    expect(toolsEqual(undefined, {})).toBe(true)
    expect(toolsEqual({ x: true }, { x: true })).toBe(true)
    expect(toolsEqual({ x: true }, { x: false })).toBe(false)
  })

  it('ignores key order', () => {
    expect(toolsEqual({ a: true, b: false }, { b: false, a: true })).toBe(true)
  })

  it('null reads as absent, as the gate does (`override ?? default`)', () => {
    expect(toolsEqual({ x: null }, {})).toBe(true)
    expect(toolsEqual({ x: null }, { x: false })).toBe(false)
  })

  it('any other non-boolean value is its own value: equal only to itself', () => {
    // The gate treats a truthy non-true value as an ordinary approval and a
    // falsy one as no approval, so neither equals true, false or absent.
    expect(toolsEqual({ x: 'yes' }, {})).toBe(false)
    expect(toolsEqual({ x: 'yes' }, { x: true })).toBe(false)
    expect(toolsEqual({ x: 'yes' }, { x: 'yes' })).toBe(true)
    expect(toolsEqual({ x: 0 }, { x: false })).toBe(false)
  })

  it('a tool toggled and restored, inserted in another key order, is unchanged', () => {
    const base = { a: true, b: false, c: true }
    const draft: Record<string, boolean> = { c: false }
    draft.b = false
    draft.c = true // toggled A -> B -> A
    draft.a = true
    expect(Object.keys(draft)).not.toEqual(Object.keys(base))
    expect(draft).not.toBe(base)
    expect(toolsEqual(base, draft)).toBe(true)
    expect(effectiveApproval({ tools: base })).toEqual(effectiveApproval({ tools: draft }))
  })

  it('a draft that differs in one tool is not equal', () => {
    const base = { a: true, b: false, c: true }
    const draft: Record<string, boolean> = { c: true, b: false, a: false }
    expect(toolsEqual(base, draft)).toBe(false)
    expect(effectiveApproval({ tools: base })).not.toEqual(effectiveApproval({ tools: draft }))
  })
})
