import { describe, expect, it } from 'vitest'
import {
  MAX_TOOL_KEYS,
  MAX_TOOL_NAME_LENGTH,
  MAX_VALUE_LENGTH,
  buildApprovalChangeSummary,
  buildHostApprovalChange,
} from '../src/services/hostApprovalAudit.js'
import { MCP_HOST_NATIVE_TOOL_NAMES } from '../src/services/mcpHostNativeToolNames.js'

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
      after: block({ shellClassifierModel: long, defaultPolicy: ['x'.repeat(300)] }),
    })
    expect(change?.fields.shellClassifierModel?.new).toBe('m'.repeat(MAX_VALUE_LENGTH))
    const extra = change?.fields.defaultPolicy?.new
    expect(typeof extra).toBe('string')
    expect((extra as string).length).toBe(MAX_VALUE_LENGTH)
    expect((extra as string).startsWith('["xxx')).toBe(true)
  })

  it('ignores every key outside the audited leaves, at any level', () => {
    const change = buildHostApprovalChange({
      before: block({ modeCeiling: 'manual' }),
      after: block({
        modeCeiling: 'allow_all',
        approverIds: ['seeded-one@example.invalid'],
        channels: {
          telegram: { enabled: true, chatIds: ['seeded-two@example.invalid'] },
          unknown: { enabled: true },
        },
      }),
    })
    expect(change?.fields).toEqual({
      modeCeiling: { old: 'manual', new: 'allow_all' },
      'channels.telegram.enabled': { old: null, new: true },
    })
    expect(change?.approvers).toEqual({})
    expect(JSON.stringify(change)).not.toMatch(/seeded-/)
  })

  it('reports a block that appears: absent to {} and null to {}', () => {
    for (const before of [undefined, null]) {
      expect(buildHostApprovalChange({ before, after: block({}) })).toEqual({
        fields: {},
        tools: {},
        toolsTruncated: 0,
        approvers: {},
        blockRemoved: false,
        inheritedBefore: true,
      })
    }
  })

  it('reports a block that disappears: {} to absent', () => {
    for (const after of [undefined, null]) {
      expect(buildHostApprovalChange({ before: block({}), after })).toEqual({
        fields: {},
        tools: {},
        toolsTruncated: 0,
        approvers: {},
        blockRemoved: true,
        inheritedBefore: false,
      })
    }
  })

  it('is null when only keys outside the audited leaves differ', () => {
    expect(
      buildHostApprovalChange({
        before: block({ modeCeiling: 'manual' }),
        after: block({ modeCeiling: 'manual', approverIds: ['seeded-one@example.invalid'] }),
      })
    ).toBeNull()
  })

  it('is null for {} to {} with only a non-schema key differing', () => {
    expect(
      buildHostApprovalChange({ before: block({}), after: block({ approverIds: ['seeded-x'] }) })
    ).toBeNull()
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

  describe('native tool names are listed first (security M-1)', () => {
    const decoys = (count: number, width: number, value: boolean): Record<string, boolean> => {
      const out: Record<string, boolean> = {}
      for (let i = 0; i < count; i += 1) {
        out[`a${String(i).padStart(width - 1, '0')}`] = value
      }
      return out
    }
    const summaryTools = (summary: string | undefined): string[] => {
      expect(summary).toBeDefined()
      expect((summary as string).length).toBeLessThanOrEqual(4096)
      return Object.keys((JSON.parse(summary as string) as { tools: object }).tools)
    }

    it('F1: 50 decoys sorted before shell_exec still list shell_exec in the line and the summary', () => {
      const before = { tools: { shell_exec: true } }
      const after = { tools: { shell_exec: false, ...decoys(50, 3, true) } }
      const change = buildHostApprovalChange({ before: block(before), after: block(after) })
      expect(Object.keys(change?.tools ?? {})[0]).toBe('shell_exec')
      expect(change?.tools.shell_exec).toEqual({ old: true, new: false })
      expect(Object.keys(change?.tools ?? {})).toHaveLength(51)
      expect(change?.toolsTruncated).toBe(0)
      const summary = buildApprovalChangeSummary({ before, after })
      expect(summaryTools(summary)).toContain('shell_exec')
    })

    it('F2: 49 decoys with 64-character names keep shell_exec in the summary', () => {
      const long: Record<string, boolean> = {}
      for (let i = 0; i < 49; i += 1) long[`a${String(i).padStart(2, '0')}${'x'.repeat(61)}`] = true
      const before = { tools: { shell_exec: true } }
      const after = { tools: { shell_exec: false, ...long } }
      const change = buildHostApprovalChange({ before: block(before), after: block(after) })
      expect(change?.tools.shell_exec).toEqual({ old: true, new: false })
      const summary = buildApprovalChangeSummary({ before, after })
      const kept = summaryTools(summary)
      expect(kept).toContain('shell_exec')
      // The trim dropped decoys and counted them, so the cut is visible.
      expect(kept.length).toBeLessThan(50)
      expect(JSON.parse(summary as string).toolsTruncated).toBe(50 - kept.length)
    })

    it('F3: decoys set to false do not push shell_exec out either', () => {
      const before = { tools: { shell_exec: true } }
      const after = { tools: { shell_exec: false, ...decoys(50, 3, false) } }
      const change = buildHostApprovalChange({ before: block(before), after: block(after) })
      expect(change?.tools.shell_exec).toEqual({ old: true, new: false })
      expect(summaryTools(buildApprovalChangeSummary({ before, after }))).toContain('shell_exec')
    })

    it('worst case: all native names changed plus decoys list every native name within 4096 characters', () => {
      const before: Record<string, boolean> = {}
      const after: Record<string, boolean> = { ...decoys(60, 3, true) }
      for (const name of MCP_HOST_NATIVE_TOOL_NAMES) {
        before[name] = true
        after[name] = false
      }
      const change = buildHostApprovalChange({
        before: block({ tools: before }),
        after: block({ tools: after }),
      })
      const listed = Object.keys(change?.tools ?? {})
      expect(listed.slice(0, MCP_HOST_NATIVE_TOOL_NAMES.length)).toEqual(
        [...MCP_HOST_NATIVE_TOOL_NAMES].sort()
      )
      expect(listed).toHaveLength(MCP_HOST_NATIVE_TOOL_NAMES.length + MAX_TOOL_KEYS)
      expect(change?.toolsTruncated).toBe(10)
      const kept = summaryTools(
        buildApprovalChangeSummary({ before: { tools: before }, after: { tools: after } })
      )
      for (const name of MCP_HOST_NATIVE_TOOL_NAMES) expect(kept).toContain(name)
    })

    it('a plain single change is unchanged', () => {
      const change = buildHostApprovalChange({
        before: block({ tools: { shell_exec: true } }),
        after: block({ tools: { shell_exec: false } }),
      })
      expect(change).toEqual({
        fields: {},
        tools: { shell_exec: { old: true, new: false } },
        toolsTruncated: 0,
        approvers: {},
        blockRemoved: false,
        inheritedBefore: false,
      })
    })
  })
})
