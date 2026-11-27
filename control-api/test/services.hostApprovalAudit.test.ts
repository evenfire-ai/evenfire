import { describe, expect, it, vi } from 'vitest'
import { Writable } from 'node:stream'
import pino from 'pino'
import { rootLogger } from '../src/observability/logger.js'
import {
  type HostApprovalChange,
  MAX_TOOL_KEYS,
  MAX_TOOL_NAME_LENGTH,
  MAX_VALUE_LENGTH,
  buildApprovalChangeSummary,
  buildHostApprovalChange,
  logHostApprovalChange,
  serializeApprovalChangeSummary,
} from '../src/services/hostApprovalAudit.js'
import { MCP_HOST_NATIVE_TOOL_NAMES } from '../src/services/mcpHostNativeToolNames.js'
import { runWithAdministrativeRequestContext } from '../src/services/tracing/adminOperationContext.js'
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
      after: block({ shellClassifierModel: long, modeCeiling: ['x'.repeat(300)] }),
    })
    expect(change?.fields.shellClassifierModel?.new).toBe('m'.repeat(MAX_VALUE_LENGTH))
    const extra = change?.fields.modeCeiling?.new
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

    it('worst case: every field changed, escaping-heavy strings, approvers on every channel, all natives and decoys: every native entry stays within 4096 characters', () => {
      const toolsBefore: Record<string, boolean> = {}
      const toolsAfter: Record<string, boolean> = { ...decoys(60, 3, true) }
      for (const name of MCP_HOST_NATIVE_TOOL_NAMES) {
        toolsBefore[name] = true
        toolsAfter[name] = false
      }
      const channels = ['telegram', 'email', 'slack', 'teams']
      const approvalOf = (flag: boolean, ceiling: string, model: string, approvers: string) => ({
        modeCeiling: ceiling,
        defaultPolicy: flag ? 'cli_only' : 'designated_approvers',
        // C1 characters escape to six characters each in the summary.
        shellClassifierModel: model.repeat(MAX_VALUE_LENGTH),
        channels: Object.fromEntries(
          channels.map(channel => [
            channel,
            {
              enabled: flag,
              allowModeChange: flag,
              approvers: Array.from({ length: 150 }, (_, i) => `${approvers}-${channel}-${i}`),
            },
          ])
        ),
        tools: flag ? toolsBefore : toolsAfter,
      })
      const before = approvalOf(true, 'manual', '\u0085', 'old')
      const after = approvalOf(false, 'allow_all', '\u0086', 'new')

      const change = buildHostApprovalChange({ before, after })
      expect(Object.keys(change?.fields ?? {})).toHaveLength(11)
      expect(Object.keys(change?.approvers ?? {})).toHaveLength(4)
      const summary = buildApprovalChangeSummary({ before, after })
      const kept = summaryTools(summary)
      for (const name of MCP_HOST_NATIVE_TOOL_NAMES) expect(kept).toContain(name)
      // Ruling 73: the long strings became markers, the other 10 fields keep
      // their values, and nothing fell back to counts.
      const parsed = JSON.parse(summary as string) as {
        truncated?: boolean
        valuesShortened?: boolean
        fields: Record<string, { old: unknown; new: unknown }>
      }
      expect(parsed.truncated).toBeUndefined()
      expect(Object.keys(parsed.fields)).toHaveLength(11)
      expect(parsed.fields.shellClassifierModel).toEqual({
        old: '(value too long)',
        new: '(value too long)',
      })
      expect(parsed.fields.modeCeiling).toEqual({ old: 'manual', new: 'allow_all' })
      // A CRD enum value is never replaced, however long it is.
      expect(parsed.fields.defaultPolicy).toEqual({ old: 'cli_only', new: 'designated_approvers' })
      expect(parsed.valuesShortened).toBe(true)
      expect(parsed.fields['channels.teams.enabled']).toEqual({ old: true, new: false })
    })

    it('a ceiling raise survives a summary that overflows with 46 natives and an escaped model', () => {
      const names = [...MCP_HOST_NATIVE_TOOL_NAMES].slice(0, 46)
      const toolsBefore = Object.fromEntries(names.map(name => [name, false]))
      const toolsAfter = Object.fromEntries(names.map(name => [name, true]))
      const before = {
        modeCeiling: 'manual',
        shellClassifierModel: '\u0085'.repeat(MAX_VALUE_LENGTH),
        tools: toolsBefore,
      }
      const after = {
        modeCeiling: 'allow_all',
        shellClassifierModel: '\u0086'.repeat(MAX_VALUE_LENGTH),
        tools: toolsAfter,
      }
      const summary = buildApprovalChangeSummary({ before, after }) as string
      expect(summary.length).toBeLessThanOrEqual(4096)
      const parsed = JSON.parse(summary) as {
        truncated?: boolean
        tools: Array<{ name: string }>
        fields: Record<string, { old: unknown; new: unknown }>
      }
      expect(parsed.fields.modeCeiling).toEqual({ old: 'manual', new: 'allow_all' })
      expect(parsed.fields.shellClassifierModel?.new).toBe('(value too long)')
      expect(parsed.tools.map(entry => entry.name).sort()).toEqual([...names].sort())
      expect(parsed.truncated).toBeUndefined()
    })

    // 57 natives, every field, and a model of escape-heavy characters on both sides.
    const worstChange = (modelLength: number, extraTools: string[] = []) => {
      const toolsBefore: Record<string, boolean> = {}
      const toolsAfter: Record<string, boolean> = {}
      for (const name of [...MCP_HOST_NATIVE_TOOL_NAMES, ...extraTools]) {
        toolsBefore[name] = true
        toolsAfter[name] = false
      }
      const channels = ['telegram', 'email', 'slack', 'teams']
      const approval = (flag: boolean) => ({
        modeCeiling: flag ? 'manual' : 'allow_all',
        defaultPolicy: flag ? 'cli_only' : 'designated_approvers',
        shellClassifierModel: (flag ? '\u0085' : '\u0086').repeat(modelLength),
        channels: Object.fromEntries(
          channels.map(channel => [
            channel,
            { enabled: flag, allowModeChange: flag, approvers: [flag ? 'a' : 'b'] },
          ])
        ),
        tools: flag ? toolsBefore : toolsAfter,
      })
      return { before: approval(true), after: approval(false) }
    }
    type Parsed = {
      truncated?: boolean
      valuesShortened?: boolean
      tools: Array<{ name: string }>
      fields: Record<string, { old: unknown; new: unknown }>
    }

    // The headroom measured for this worst case (every field changed, four
    // channels, escape-heavy model): with two more native tools, and with
    // three, the summary still fits in tier 2; with four it falls to tier 3.
    const SYNTHETIC = ['synthetic_native_a', 'synthetic_native_b']
    const syntheticNative = (name: string): boolean =>
      MCP_HOST_NATIVE_TOOL_NAMES.includes(name) || SYNTHETIC.includes(name)

    it.each([
      [16, 2],
      [128, 0],
      [128, 2],
    ])(
      'a %i-character escape-heavy model with %i extra natives never hides the ceiling raise or the policy widening',
      (modelLength, extraCount) => {
        const extra = SYNTHETIC.slice(0, extraCount)
        const { before, after } = worstChange(modelLength, extra)
        const change = buildHostApprovalChange({ before, after })
        const text = serializeApprovalChangeSummary(change as NonNullable<typeof change>, {
          isNative: syntheticNative,
        })
        expect(text.length).toBeLessThanOrEqual(4096)
        const parsed = JSON.parse(text) as Parsed
        expect(parsed.truncated).toBeUndefined()
        expect(parsed.fields.modeCeiling).toEqual({ old: 'manual', new: 'allow_all' })
        expect(parsed.fields.defaultPolicy).toEqual({
          old: 'cli_only',
          new: 'designated_approvers',
        })
        expect(parsed.fields['channels.slack.allowModeChange']).toEqual({ old: true, new: false })
        expect(Object.keys(parsed.fields)).toHaveLength(11)
        expect(parsed.tools).toHaveLength(MCP_HOST_NATIVE_TOOL_NAMES.length + extra.length)
        expect(parsed.fields.shellClassifierModel?.new).toBe('(value too long)')
        expect(parsed.valuesShortened).toBe(true)
      }
    )

    it.each([4, 10])(
      'tier 3 with %i extra natives keeps the ceiling and policy values beside the counts',
      extraCount => {
        const extra = Array.from({ length: extraCount }, (_, i) => `synthetic_native_${i}`)
        const { before, after } = worstChange(128, extra)
        const change = buildHostApprovalChange({ before, after })
        const text = serializeApprovalChangeSummary(change as NonNullable<typeof change>, {
          isNative: name => MCP_HOST_NATIVE_TOOL_NAMES.includes(name) || extra.includes(name),
        })
        expect(text.length).toBeLessThanOrEqual(4096)
        const parsed = JSON.parse(text) as Parsed & {
          fieldCount: number
          nativeToolsTruncated?: number
        }
        expect(parsed.truncated).toBe(true)
        expect(parsed.nativeToolsTruncated).toBeUndefined()
        expect(parsed.tools).toHaveLength(MCP_HOST_NATIVE_TOOL_NAMES.length + extraCount)
        expect(parsed.fields).toEqual({
          modeCeiling: { old: 'manual', new: 'allow_all' },
          defaultPolicy: { old: 'cli_only', new: 'designated_approvers' },
        })
        // The per-channel booleans fall to counts.
        expect(parsed.fieldCount).toBe(11)
      }
    )

    // L1254: FIELD_ENUMS is read with Object.hasOwn. A field whose key is an
    // Object.prototype member is no enum field (serializeApprovalChangeSummary
    // takes any change, though buildHostApprovalChange makes no such key).
    const prototypeKeyChange = (others: number): HostApprovalChange => ({
      fields: {
        toString: { old: 'a'.repeat(3000), new: 'b'.repeat(3000) },
        ...Object.fromEntries(
          Array.from({ length: others }, (_, i) => [
            `channels.c${String(i).padStart(3, '0')}.enabled`,
            { old: true, new: false },
          ])
        ),
      },
      tools: [],
      toolsTruncated: 0,
      approvers: {},
      blockRemoved: false,
      inheritedBefore: false,
    })

    it('a field named like an Object.prototype member is shortened as a plain string (L1254)', () => {
      const parsed = JSON.parse(serializeApprovalChangeSummary(prototypeKeyChange(0))) as Parsed
      expect(parsed.truncated).toBeUndefined()
      expect(parsed.valuesShortened).toBe(true)
      expect(parsed.fields.toString).toEqual({ old: '(value too long)', new: '(value too long)' })
    })

    it('a field named like an Object.prototype member is not kept beside the counts (L1254)', () => {
      const text = serializeApprovalChangeSummary(prototypeKeyChange(200))
      expect(text.length).toBeLessThanOrEqual(4096)
      const parsed = JSON.parse(text) as Partial<Parsed> & { fieldCount: number }
      expect(parsed.truncated).toBe(true)
      expect(parsed.fieldCount).toBe(201)
      expect(parsed.fields).toBeUndefined()
    })

    it('the not-a-policy marker survives the shortening', () => {
      const names = [...MCP_HOST_NATIVE_TOOL_NAMES].slice(0, 46)
      const before = {
        defaultPolicy: 'cli_only',
        shellClassifierModel: '\u0085'.repeat(MAX_VALUE_LENGTH),
        tools: Object.fromEntries(names.map(name => [name, false])),
      }
      const after = {
        defaultPolicy: 'typed-by-an-admin',
        shellClassifierModel: '\u0086'.repeat(MAX_VALUE_LENGTH),
        tools: Object.fromEntries(names.map(name => [name, true])),
      }
      const parsed = JSON.parse(buildApprovalChangeSummary({ before, after }) as string) as Parsed
      expect(parsed.valuesShortened).toBe(true)
      expect(parsed.fields.defaultPolicy).toEqual({
        old: 'cli_only',
        new: '(not a policy value)',
      })
    })

    it('tier 4: natives that cannot fit are cut from the end, counted, and logged as a warning', () => {
      const warn = vi.fn()
      const spy = vi.spyOn(rootLogger, 'child').mockReturnValue({ warn } as never)
      try {
        const names = Array.from(
          { length: 200 },
          (_, i) => `synthetic_native_tool_${String(i).padStart(3, '0')}`
        )
        const change = {
          fields: { modeCeiling: { old: 'manual' as const, new: 'allow_all' as const } },
          tools: names.map(name => ({ name, old: true, new: false })),
          toolsTruncated: 0,
          approvers: {},
          blockRemoved: false,
          inheritedBefore: false,
        }
        const text = runWithAdministrativeRequestContext(
          { operatorSub: 'operator-fixture', requestId: 'request-fixture-1' },
          () => serializeApprovalChangeSummary(change, { isNative: () => true, host: 'foo' })
        )
        expect(text.length).toBeLessThanOrEqual(4096)
        const parsed = JSON.parse(text) as {
          truncated: boolean
          fields?: Record<string, { old: unknown; new: unknown }>
          tools: Array<{ name: string }>
          nativeToolsTruncated: number
        }
        expect(parsed.truncated).toBe(true)
        // Ruling 76: tier 4 keeps the changed ceiling beside the counts, ahead
        // of the native entries it cuts.
        expect(parsed.fields).toEqual({ modeCeiling: { old: 'manual', new: 'allow_all' } })
        expect(parsed.tools.length + parsed.nativeToolsTruncated).toBe(200)
        expect(parsed.nativeToolsTruncated).toBeGreaterThan(0)
        // Cut from the end: the kept ones are the first, in order.
        expect(parsed.tools.map(entry => entry.name)).toEqual(names.slice(0, parsed.tools.length))
        expect(warn).toHaveBeenCalledTimes(1)
        const [payload] = warn.mock.calls[0] as [Record<string, unknown>]
        expect(payload).toMatchObject({
          event: 'host_approval_summary_oversize',
          host: 'foo',
          requestId: 'request-fixture-1',
          nativeToolsTruncated: parsed.nativeToolsTruncated,
        })
        expect(typeof payload.length).toBe('number')
      } finally {
        spy.mockRestore()
      }
    })

    it('all natives changed plus decoys, with no field change, list every native name', () => {
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

    it('M2: the line shows bidi and C1 characters in string values as \\uXXXX text', () => {
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
      const spy = vi.spyOn(rootLogger, 'child').mockReturnValue(logger as never)
      try {
        const change = buildHostApprovalChange({
          before: block({ shellClassifierModel: 'plain', tools: {} }),
          after: block({
            shellClassifierModel: 'model\u202e\u0085\u061c\u2028\u2029',
            tools: { 'shell\u202eexe': false, shell_exec: false },
          }),
        })
        logHostApprovalChange({
          change: change as NonNullable<typeof change>,
          host: 'foo',
          namespace: 'ns',
          operatorSub: null,
          operationId: null,
          via: 'host_put',
        })
      } finally {
        spy.mockRestore()
      }
      expect(lines).toHaveLength(1)
      // eslint-disable-next-line no-misleading-character-class
      expect(
        /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(
          lines[0] as string
        )
      ).toBe(false)
      const logged = JSON.parse(lines[0] as string) as {
        fields: { shellClassifierModel: { new: string } }
        tools: Array<{ name: string }>
      }
      expect(logged.fields.shellClassifierModel.new).toBe(
        'model\\u202e\\u0085\\u061c\\u2028\\u2029'
      )
      expect(logged.tools.map(entry => entry.name)).toEqual(['shell_exec', 'shell\\u202eexe'])
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
      const spy = vi.spyOn(rootLogger, 'child').mockReturnValue(logger as never)
      const change = buildHostApprovalChange({
        before: block({ tools: { shell_exec: true } }),
        after: block({ tools: { shell_exec: false, access_token: false, id_token: false } }),
      })
      expect(change).not.toBeNull()
      try {
        logHostApprovalChange({
          change: change as NonNullable<typeof change>,
          host: 'foo',
          namespace: 'ns',
          operatorSub: null,
          operationId: null,
          via: 'host_put',
        })
      } finally {
        spy.mockRestore()
      }
      expect(lines).toHaveLength(1)
      const logged = JSON.parse(lines[0] as string) as { tools: Array<{ name: string }> }
      expect(logged.tools.map(entry => entry.name).sort()).toEqual([
        'access_token',
        'id_token',
        'shell_exec',
      ])
    })
  })

  describe('free text in the durable summary (security m-2)', () => {
    it('P5: bidi and C1 characters in a tool name or value are escaped in the summary', () => {
      const hostile = [
        '\u202e',
        '\u0085',
        '\u200f',
        '\u2066',
        '\u009f',
        '\u061c',
        '\u2028',
        '\u2029',
      ].join('')
      const before = { tools: {}, shellClassifierModel: 'plain' }
      const after = {
        tools: { [`shell${hostile}exe`]: false },
        shellClassifierModel: `model${hostile}`,
      }
      const summary = buildApprovalChangeSummary({ before, after }) as string
      expect(summary).toBeDefined()
      // eslint-disable-next-line no-misleading-character-class
      expect(
        /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(
          summary
        )
      ).toBe(false)
      const parsedSummary = JSON.parse(summary) as {
        tools: Array<{ name: string }>
        fields: { shellClassifierModel: { new: string } }
      }
      expect(parsedSummary.tools[0]?.name).toBe(`shell${hostile}exe`)
      expect(parsedSummary.fields.shellClassifierModel.new).toBe(`model${hostile}`)
    })

    it('a defaultPolicy outside the CRD enum is recorded as a fixed marker, never as null (valid to invalid)', () => {
      const before = block({ defaultPolicy: 'cli_only', modeCeiling: 'manual' })
      const after = block({
        defaultPolicy: 'typed-by-an-admin-not-a-policy',
        modeCeiling: 'auto',
      })
      const change = buildHostApprovalChange({ before, after })
      expect(change?.fields.defaultPolicy).toEqual({ old: 'cli_only', new: '(not a policy value)' })
      // The partner: the same write's modeCeiling change is audited.
      expect(change?.fields.modeCeiling).toEqual({ old: 'manual', new: 'auto' })
      const summary = buildApprovalChangeSummary({ before, after }) as string
      expect(summary).toContain('(not a policy value)')
      expect(summary).not.toContain('typed-by-an-admin')
    })

    it('a stored defaultPolicy outside the enum becoming valid shows the marker as old (invalid to valid)', () => {
      const change = buildHostApprovalChange({
        before: block({ defaultPolicy: 'legacy-free-text' }),
        after: block({ defaultPolicy: 'channel_users' }),
      })
      expect(change?.fields).toEqual({
        defaultPolicy: { old: '(not a policy value)', new: 'channel_users' },
      })
      expect(JSON.stringify(change)).not.toContain('legacy-free-text')
    })

    it('a non-string defaultPolicy is a marker too, whatever String() would make of it', () => {
      const change = buildHostApprovalChange({
        before: block({ defaultPolicy: 'cli_only' }),
        after: block({ defaultPolicy: ['cli_only'] }),
      })
      expect(change?.fields.defaultPolicy).toEqual({ old: 'cli_only', new: '(not a policy value)' })
    })

    it('a defaultPolicy that is an enum value is still audited', () => {
      const change = buildHostApprovalChange({
        before: block({ defaultPolicy: 'cli_only' }),
        after: block({ defaultPolicy: 'channel_users' }),
      })
      expect(change?.fields).toEqual({ defaultPolicy: { old: 'cli_only', new: 'channel_users' } })
    })
  })
})
