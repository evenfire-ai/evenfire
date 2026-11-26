import { describe, expect, it, vi } from 'vitest'
import { Writable } from 'node:stream'
import pino from 'pino'
import { rootLogger } from '../src/observability/logger.js'
import {
  MAX_TOOL_KEYS,
  MAX_TOOL_NAME_LENGTH,
  MAX_VALUE_LENGTH,
  buildApprovalChangeSummary,
  buildHostApprovalChange,
  logHostApprovalChange,
} from '../src/services/hostApprovalAudit.js'
import { MCP_HOST_NATIVE_TOOL_NAMES } from '../src/services/mcpHostNativeToolNames.js'
import { TOKEN_LEAK_REDACT_PATHS } from '../src/utils/log/redact.js'

const block = (approval?: Record<string, unknown>): Record<string, unknown> | undefined => approval
const toolNames = (change: { tools: Array<{ name: string }> } | null | undefined): string[] =>
  (change?.tools ?? []).map(entry => entry.name)

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
    expect(change?.tools).toHaveLength(MAX_TOOL_KEYS)
    expect(change?.toolsTruncated).toBe(10)
    expect(change?.tools[0]).toEqual({ name: 'tool_00', old: null, new: true })
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
        tools: [],
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
        tools: [],
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
    expect(change?.tools).toEqual([{ name: 't'.repeat(64), old: null, new: false }])
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
      return (JSON.parse(summary as string) as { tools: Array<{ name: string }> }).tools.map(
        entry => entry.name
      )
    }

    it('F1: 50 decoys sorted before shell_exec still list shell_exec in the line and the summary', () => {
      const before = { tools: { shell_exec: true } }
      const after = { tools: { shell_exec: false, ...decoys(50, 3, true) } }
      const change = buildHostApprovalChange({ before: block(before), after: block(after) })
      expect(toolNames(change)[0]).toBe('shell_exec')
      expect(change?.tools[0]).toEqual({ name: 'shell_exec', old: true, new: false })
      expect(change?.tools).toHaveLength(51)
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
      expect(change?.tools[0]).toEqual({ name: 'shell_exec', old: true, new: false })
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
      expect(change?.tools[0]).toEqual({ name: 'shell_exec', old: true, new: false })
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
      const listed = toolNames(change)
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
        tools: [{ name: 'shell_exec', old: true, new: false }],
        toolsTruncated: 0,
        approvers: {},
        blockRemoved: false,
        inheritedBefore: false,
      })
    })
  })

  describe('no changed tool vanishes from the audit (security m-1)', () => {
    // JSON.parse makes `__proto__` an own key, as a request body does.
    const parsed = (text: string): Record<string, unknown> =>
      JSON.parse(text) as Record<string, unknown>

    it('P1: a changed tool named __proto__ is audited and the summary exists', () => {
      const before = parsed('{"tools":{}}')
      const after = parsed('{"tools":{"__proto__":false}}')
      const change = buildHostApprovalChange({ before, after })
      expect(change?.tools).toEqual([{ name: '__proto__', old: null, new: false }])
      const summary = buildApprovalChangeSummary({ before, after })
      expect(summary).toBeDefined()
      expect(toolNames(JSON.parse(summary as string))).toEqual(['__proto__'])
    })

    it('P2: __proto__ next to a real change does not hide either', () => {
      const before = parsed('{"tools":{"shell_exec":true}}')
      const after = parsed('{"tools":{"shell_exec":false,"__proto__":false}}')
      const change = buildHostApprovalChange({ before, after })
      expect(toolNames(change)).toEqual(['shell_exec', '__proto__'])
      expect(
        toolNames(JSON.parse(buildApprovalChangeSummary({ before, after }) as string))
      ).toEqual(['shell_exec', '__proto__'])
    })

    it('P3: two names sharing their first 64 characters stay two entries', () => {
      const first = `${'p'.repeat(64)}one`
      const second = `${'p'.repeat(64)}two`
      const change = buildHostApprovalChange({
        before: block({ tools: {} }),
        after: block({ tools: { [first]: true, [second]: false } }),
      })
      expect(change?.tools).toEqual([
        { name: 'p'.repeat(64), old: null, new: true },
        { name: 'p'.repeat(64), old: null, new: false },
      ])
      expect(change?.toolsTruncated).toBe(0)
    })

    it('L1: the root logger redaction keeps tools named like a redacted key', async () => {
      const lines: string[] = []
      const logger = pino(
        { redact: { paths: [...TOKEN_LEAK_REDACT_PATHS], remove: true } },
        new Writable({
          write(chunk, _encoding, done) {
            lines.push(String(chunk))
            done()
          },
        })
      )
      vi.spyOn(rootLogger, 'child').mockReturnValue(logger as never)
      const change = buildHostApprovalChange({
        before: block({ tools: { shell_exec: true } }),
        after: block({ tools: { shell_exec: false, access_token: false, id_token: false } }),
      })
      expect(change).not.toBeNull()
      logHostApprovalChange({
        change: change as NonNullable<typeof change>,
        host: 'foo',
        namespace: 'ns',
        operatorSub: null,
        operationId: null,
        via: 'host_put',
      })
      expect(lines).toHaveLength(1)
      const logged = JSON.parse(lines[0] as string) as { tools: Array<{ name: string }> }
      expect(logged.tools.map(entry => entry.name).sort()).toEqual([
        'access_token',
        'id_token',
        'shell_exec',
      ])
      vi.restoreAllMocks()
    })
  })
})
