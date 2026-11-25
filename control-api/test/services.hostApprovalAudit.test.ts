import { describe, expect, it } from 'vitest'
import {
  MAX_TOOL_KEYS,
  MAX_VALUE_LENGTH,
  buildHostApprovalChange,
} from '../src/services/hostApprovalAudit.js'

const host = (approval?: Record<string, unknown>): Record<string, unknown> => ({
  spec: { host: 'foo', ...(approval ? { approval } : {}) },
})

describe('buildHostApprovalChange', () => {
  it('is null when the approval blocks are equal', () => {
    const a = { defaultPolicy: 'cli_only', channels: { slack: { enabled: true } } }
    expect(buildHostApprovalChange({ before: host(a), after: host({ ...a }) })).toBeNull()
    expect(buildHostApprovalChange({ before: host(), after: host() })).toBeNull()
  })

  it('lists a changed field with its old and new value', () => {
    const change = buildHostApprovalChange({
      before: host({ modeCeiling: 'manual', channels: { slack: { allowModeChange: true } } }),
      after: host({ modeCeiling: 'allow_all', channels: { slack: { allowModeChange: false } } }),
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
      before: host({ tools: {} }),
      after: host({ tools }),
    })
    expect(Object.keys(change?.tools ?? {})).toHaveLength(MAX_TOOL_KEYS)
    expect(change?.toolsTruncated).toBe(10)
    expect(change?.tools.tool_00).toEqual({ old: null, new: true })
  })

  it('counts approvers and never serializes one', () => {
    const change = buildHostApprovalChange({
      before: host({ channels: { telegram: { approvers: ['secret-alice', 'secret-bob'] } } }),
      after: host({
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
      after: host({ modeCeiling: 'auto' }),
    })
    expect(created?.inheritedBefore).toBe(true)
    expect(created?.fields).toEqual({ modeCeiling: { old: null, new: 'auto' } })

    const removed = buildHostApprovalChange({
      before: host({ modeCeiling: 'auto' }),
      after: host(),
    })
    expect(removed?.blockRemoved).toBe(true)
    expect(removed?.inheritedBefore).toBe(false)
    expect(removed?.fields).toEqual({ modeCeiling: { old: 'auto', new: null } })
  })

  it('cuts a long value to 128 characters and shows a non-primitive leaf as cut JSON', () => {
    const long = 'm'.repeat(300)
    const change = buildHostApprovalChange({
      before: host({ shellClassifierModel: 'a' }),
      after: host({ shellClassifierModel: long, extra: ['x'.repeat(300)] }),
    })
    expect(change?.fields.shellClassifierModel?.new).toBe('m'.repeat(MAX_VALUE_LENGTH))
    const extra = change?.fields.extra?.new
    expect(typeof extra).toBe('string')
    expect((extra as string).length).toBe(MAX_VALUE_LENGTH)
    expect((extra as string).startsWith('["xxx')).toBe(true)
  })
})
