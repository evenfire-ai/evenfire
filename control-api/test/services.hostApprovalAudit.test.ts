import { describe, expect, it } from 'vitest'
import {
  MAX_TOOL_KEYS,
  MAX_TOOL_NAME_LENGTH,
  MAX_VALUE_LENGTH,
  buildHostApprovalChange,
} from '../src/services/hostApprovalAudit.js'

const block = (approval?: Record<string, unknown>): Record<string, unknown> | undefined => approval

describe('buildHostApprovalChange', () => {
  it('is null when the approval blocks are equal', () => {
    const a = { defaultPolicy: 'cli_only', channels: { slack: { enabled: true } } }
    expect(buildHostApprovalChange({ before: block(a), after: block({ ...a }) })).toBeNull()
    expect(buildHostApprovalChange({ before: block(), after: block() })).toBeNull()
  })

  it('lists a changed field with its old and new value', () => {
    const change = buildHostApprovalChange({
      before: block({ modeCeiling: 'manual', channels: { slack: { allowModeChange: true } } }),
      after: block({ modeCeiling: 'allow_all', channels: { slack: { allowModeChange: false } } }),
    })
    expect(change?.fields).toEqual({
      modeCeiling: { old: 'manual', new: 'allow_all' },
      'channels.slack.allowModeChange': { old: true, new: false },
    })
    expect(change?.blockRemoved).toBe(false)
    expect(change?.inheritedBefore).toBe(false)
  })

  it('caps the changed tools at 50 and counts the rest', () => {
    const tools: Record<string, boolean> = {}
    for (let i = 0; i < 60; i += 1) tools[`tool_${String(i).padStart(2, '0')}`] = true
    const change = buildHostApprovalChange({
      before: block({ tools: {} }),
      after: block({ tools }),
    })
    expect(Object.keys(change?.tools ?? {})).toHaveLength(MAX_TOOL_KEYS)
    expect(change?.toolsTruncated).toBe(10)
    expect(change?.tools.tool_00).toEqual({ old: null, new: true })
  })

  it('counts approvers and never serializes one', () => {
    const change = buildHostApprovalChange({
      before: block({ channels: { telegram: { approvers: ['secret-alice', 'secret-bob'] } } }),
      after: block({
        channels: { telegram: { approvers: ['secret-bob', 'secret-carol', 'secret-dan'] } },
      }),
    })
    expect(change?.approvers).toEqual({ 'channels.telegram': { added: 2, removed: 1 } })
    expect(change?.fields).toEqual({})
    expect(JSON.stringify(change)).not.toMatch(/secret-/)
  })

  it('reports an inherited block on create and a removed block', () => {
    const created = buildHostApprovalChange({
      before: undefined,
      after: block({ modeCeiling: 'auto' }),
    })
    expect(created?.inheritedBefore).toBe(true)
    expect(created?.fields).toEqual({ modeCeiling: { old: null, new: 'auto' } })

    const removed = buildHostApprovalChange({
      before: block({ modeCeiling: 'auto' }),
      after: block(),
    })
    expect(removed?.blockRemoved).toBe(true)
    expect(removed?.inheritedBefore).toBe(false)
    expect(removed?.fields).toEqual({ modeCeiling: { old: 'auto', new: null } })
  })

  it('cuts a long value to 128 characters and shows a non-primitive leaf as cut JSON', () => {
    const long = 'm'.repeat(300)
    const change = buildHostApprovalChange({
      before: block({ shellClassifierModel: 'a' }),
      after: block({ shellClassifierModel: long, extra: ['x'.repeat(300)] }),
    })
    expect(change?.fields.shellClassifierModel?.new).toBe('m'.repeat(MAX_VALUE_LENGTH))
    const extra = change?.fields.extra?.new
    expect(typeof extra).toBe('string')
    expect((extra as string).length).toBe(MAX_VALUE_LENGTH)
    expect((extra as string).startsWith('["xxx')).toBe(true)
  })

  it('cuts a tool name to 64 characters', () => {
    const longName = 't'.repeat(200)
    const change = buildHostApprovalChange({
      before: block({ tools: {} }),
      after: block({ tools: { [longName]: false } }),
    })
    expect(MAX_TOOL_NAME_LENGTH).toBe(64)
    expect(Object.keys(change?.tools ?? {})).toEqual(['t'.repeat(64)])
    expect(change?.tools['t'.repeat(64)]).toEqual({ old: null, new: false })
  })
})
