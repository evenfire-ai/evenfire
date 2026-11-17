import { afterEach, describe, expect, it, vi } from 'vitest'
import { register } from 'prom-client'
import { clerumSpilloverReadsTotal } from '../../core/spillover'
import { SpilloverReadTool } from '../../core/tools/spilloverRead'
import { logger } from '../../logger'
import {
  STEP_SPILLOVER_READ_TOOL_NAME,
  type StepSpillover,
  clerumWorkflowStepSpilloverReadsTotal,
  countStepSpilloverRead,
  createStepSpillover,
  resolveStepSpilloverConfig,
  storableToolText,
  summarizeSpilloverReadForRecord,
} from '../stepSpillover'

const THRESHOLD = 4096
// The read tool takes a workspace path from its caller; the step store does not use it.
const WORKSPACE = '/workspace'
// Size of a string as the caller would paste it; these tests store what they paste.
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

describe('resolveStepSpilloverConfig', () => {
  it('defaults to enabled, 128 KiB threshold and 16 MiB budget', () => {
    expect(resolveStepSpilloverConfig({})).toEqual({
      enabled: true,
      thresholdBytes: 131072,
      budgetBytes: 16777216,
    })
  })

  it('treats an empty ENABLED as enabled', () => {
    expect(resolveStepSpilloverConfig({ CLERUM_WORKFLOW_TOOL_SPILLOVER_ENABLED: '' }).enabled).toBe(
      true
    )
  })

  it.each(['false', 'FALSE', ' false '])('disables only on the literal false (%j)', value => {
    expect(
      resolveStepSpilloverConfig({ CLERUM_WORKFLOW_TOOL_SPILLOVER_ENABLED: value }).enabled
    ).toBe(false)
  })

  it.each(['0', 'no', 'off', 'disabled'])('keeps spillover enabled for %j', value => {
    expect(
      resolveStepSpilloverConfig({ CLERUM_WORKFLOW_TOOL_SPILLOVER_ENABLED: value }).enabled
    ).toBe(true)
  })

  it('accepts sizes within bounds', () => {
    expect(
      resolveStepSpilloverConfig({
        CLERUM_WORKFLOW_TOOL_SPILLOVER_THRESHOLD: '65536',
        CLERUM_WORKFLOW_TOOL_SPILLOVER_BUDGET_BYTES: '1048576',
      })
    ).toMatchObject({ thresholdBytes: 65536, budgetBytes: 1048576 })
  })

  it.each(['abc', '4095', '1048577', '8192.5', '-1'])('ignores threshold %j', value => {
    expect(
      resolveStepSpilloverConfig({ CLERUM_WORKFLOW_TOOL_SPILLOVER_THRESHOLD: value }).thresholdBytes
    ).toBe(131072)
  })

  it.each(['1e5', '0x10000', '0b10000000000000000', '0o200000', '65536.0', '65536.', '+65536'])(
    'ignores threshold %j, which is in bounds but not written in decimal digits',
    value => {
      // Witness: the same number written in decimal digits is accepted.
      expect(
        resolveStepSpilloverConfig({ CLERUM_WORKFLOW_TOOL_SPILLOVER_THRESHOLD: '65536' })
          .thresholdBytes
      ).toBe(65536)
      expect(
        resolveStepSpilloverConfig({ CLERUM_WORKFLOW_TOOL_SPILLOVER_THRESHOLD: value })
          .thresholdBytes
      ).toBe(131072)
    }
  )

  it('accepts decimal digits with surrounding whitespace', () => {
    expect(
      resolveStepSpilloverConfig({ CLERUM_WORKFLOW_TOOL_SPILLOVER_THRESHOLD: ' 65536 ' })
        .thresholdBytes
    ).toBe(65536)
  })

  it('ignores a budget in bounds that is not written in decimal digits', () => {
    // Witness: the same number written in decimal digits is accepted.
    expect(
      resolveStepSpilloverConfig({ CLERUM_WORKFLOW_TOOL_SPILLOVER_BUDGET_BYTES: '2097152' })
        .budgetBytes
    ).toBe(2097152)
    expect(
      resolveStepSpilloverConfig({ CLERUM_WORKFLOW_TOOL_SPILLOVER_BUDGET_BYTES: '0x200000' })
        .budgetBytes
    ).toBe(16777216)
  })

  it.each(['abc', '1048575', '268435457'])('ignores budget %j', value => {
    expect(
      resolveStepSpilloverConfig({ CLERUM_WORKFLOW_TOOL_SPILLOVER_BUDGET_BYTES: value }).budgetBytes
    ).toBe(16777216)
  })

  it('ignores the first-party CLERUM_TOOL_SPILLOVER_ENABLED', () => {
    expect(resolveStepSpilloverConfig({ CLERUM_TOOL_SPILLOVER_ENABLED: 'false' }).enabled).toBe(
      true
    )
    expect(
      resolveStepSpilloverConfig({
        CLERUM_TOOL_SPILLOVER_ENABLED: 'true',
        CLERUM_WORKFLOW_TOOL_SPILLOVER_ENABLED: 'false',
      }).enabled
    ).toBe(false)
  })
})

describe('createStepSpillover', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function make(overrides: Partial<{ stepId: string; budgetBytes: number }> = {}): StepSpillover {
    const spillover = createStepSpillover({
      stepId: overrides.stepId ?? 'review-step',
      thresholdBytes: THRESHOLD,
      budgetBytes: overrides.budgetBytes ?? 1048576,
    })
    if (!spillover) throw new Error('expected a spillover')
    return spillover
  }

  it.each(['', 'a/b', '../x', 'a.b'])('returns null for an invalid step id %j', stepId => {
    expect(createStepSpillover({ stepId, thresholdBytes: 4096, budgetBytes: 1 })).toBe(null)
  })

  describe('persist', () => {
    it('keeps a result under the threshold inline', async () => {
      const content = 'x'.repeat(THRESHOLD - 1)
      const res = await make().persist({
        callId: 'c1',
        toolName: 'srv__t',
        content,
        inlineBytes: bytes(content),
        isError: false,
      })
      expect(res).toEqual({ text: content, spilled: false })
    })

    it('never spills an error result', async () => {
      const content = 'e'.repeat(THRESHOLD * 2)
      const res = await make().persist({
        callId: 'c1',
        toolName: 'srv__t',
        content,
        inlineBytes: bytes(content),
        isError: true,
      })
      expect(res).toEqual({ text: content, spilled: false })
    })

    it('never spills the read tool itself', async () => {
      const content = 'r'.repeat(THRESHOLD * 2)
      const res = await make().persist({
        callId: 'c1',
        toolName: STEP_SPILLOVER_READ_TOOL_NAME,
        content,
        inlineBytes: bytes(content),
        isError: false,
      })
      expect(res).toEqual({ text: content, spilled: false })
    })

    it('warns once per execution however many results miss the budget', async () => {
      const warn = vi.spyOn(logger, 'warn')
      const budgetWarnings = () =>
        warn.mock.calls.filter(
          ([, msg]) =>
            msg ===
            'Tool result does not fit in the step spillover budget; it stays inline (logged once per step)'
        )
      const run = async (spillover: StepSpillover): Promise<boolean[]> => {
        const outcomes: boolean[] = []
        for (const callId of ['c1', 'c2', 'c3']) {
          const res = await spillover.persist({
            callId,
            toolName: 't',
            content: 'b'.repeat(6000),
            inlineBytes: 6000,
            isError: false,
          })
          outcomes.push(res.spilled)
        }
        return outcomes
      }

      expect(await run(make({ budgetBytes: 10000 }))).toEqual([true, false, false])
      expect(budgetWarnings()).toHaveLength(1)
      expect(budgetWarnings()[0]![0]).toMatchObject({ stepId: 'review-step', budgetBytes: 10000 })

      // Another execution of the same step logs its own first miss.
      expect(await run(make({ budgetBytes: 10000 }))).toEqual([true, false, false])
      expect(budgetWarnings()).toHaveLength(2)
    })

    it('counts the stored string against the budget, not the inline size', async () => {
      const spillover = make({ budgetBytes: 10000 })
      const outcomes: boolean[] = []
      for (const callId of ['c1', 'c2', 'c3']) {
        // 4500 stored bytes per result, 6000 inline: two fit by stored size (9000),
        // only one would fit by inline size (12000 > 10000).
        const res = await spillover.persist({
          callId,
          toolName: 't',
          content: 'b'.repeat(4500),
          inlineBytes: 6000,
          isError: false,
        })
        outcomes.push(res.spilled)
      }
      // The third result (13500 stored bytes in all) shows the budget is applied.
      expect(outcomes).toEqual([true, true, false])
    })

    it('measures the stored result in UTF-8 bytes, not characters', async () => {
      const spillover = make()
      // 2000 characters, 6000 bytes: under the threshold by characters, over it by bytes.
      const content = '€'.repeat(2000)
      const res = await spillover.persist({
        callId: 'c1',
        toolName: 't',
        content,
        inlineBytes: bytes(content),
        isError: false,
      })
      expect(res.spilled).toBe(true)
      expect(res.text).toContain('(6000 bytes)')
      expect(res.text).toContain('"byte_size":6000')
      // A whole read is refused because the stored result is 6000 bytes.
      const whole = await spillover.readTool.execute(
        { ref: 'spillover://review-step/c1.json' },
        WORKSPACE
      )
      expect(whole).toEqual({
        success: false,
        error: `blob is 6000 bytes; pass range {start,end} with end-start <= ${THRESHOLD}`,
      })
      // Witness: a range read of the same blob is served.
      const part = await spillover.readTool.execute(
        { ref: 'spillover://review-step/c1.json', range: { start: 0, end: 30 } },
        WORKSPACE
      )
      expect(part).toEqual({ success: true, content: '€'.repeat(10) })
    })
  })

  describe('readTool', () => {
    const blob = (size: number): string =>
      Array.from({ length: size }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')

    it('reads a whole blob no larger than the threshold', async () => {
      const spillover = make()
      const content = blob(THRESHOLD)
      await spillover.persist({
        callId: 'c1',
        toolName: 't',
        content,
        inlineBytes: bytes(content),
        isError: false,
      })
      const res = await spillover.readTool.execute(
        { ref: 'spillover://review-step/c1.json' },
        WORKSPACE
      )
      expect(res).toEqual({ success: true, content })
    })

    it('rejects a whole read of a blob larger than the threshold', async () => {
      const spillover = make()
      await spillover.persist({
        callId: 'c1',
        toolName: 't',
        content: blob(THRESHOLD + 1),
        inlineBytes: THRESHOLD + 1,
        isError: false,
      })
      const res = await spillover.readTool.execute(
        { ref: 'spillover://review-step/c1.json' },
        WORKSPACE
      )
      expect(res).toEqual({
        success: false,
        error: `blob is ${THRESHOLD + 1} bytes; pass range {start,end} with end-start <= ${THRESHOLD}`,
      })
    })

    it('returns the requested range', async () => {
      const spillover = make()
      const content = blob(THRESHOLD * 3)
      await spillover.persist({
        callId: 'c1',
        toolName: 't',
        content,
        inlineBytes: bytes(content),
        isError: false,
      })
      const res = await spillover.readTool.execute(
        { ref: 'spillover://review-step/c1.json', range: { start: 100, end: 200 } },
        WORKSPACE
      )
      expect(res).toEqual({ success: true, content: content.slice(100, 200) })
    })

    it('serves a range exactly the threshold wide', async () => {
      const spillover = make()
      // ASCII blob: bytes and characters coincide.
      const content = blob(THRESHOLD * 3)
      await spillover.persist({
        callId: 'c1',
        toolName: 't',
        content,
        inlineBytes: bytes(content),
        isError: false,
      })
      const res = await spillover.readTool.execute(
        { ref: 'spillover://review-step/c1.json', range: { start: 0, end: THRESHOLD } },
        WORKSPACE
      )
      expect(res).toEqual({ success: true, content: content.slice(0, THRESHOLD) })
    })

    it('rejects a range wider than the threshold with the range width', async () => {
      const spillover = make()
      await spillover.persist({
        callId: 'c1',
        toolName: 't',
        content: blob(THRESHOLD * 3),
        inlineBytes: THRESHOLD * 3,
        isError: false,
      })
      const res = await spillover.readTool.execute(
        { ref: 'spillover://review-step/c1.json', range: { start: 0, end: THRESHOLD + 1 } },
        WORKSPACE
      )
      expect(res).toEqual({
        success: false,
        error: `range is ${THRESHOLD + 1} bytes wide; reads are limited to ${THRESHOLD} bytes, pass a range with end-start <= ${THRESHOLD}`,
      })
      // Witness that the two branches differ: a whole read of the same blob
      // still reports the blob size.
      const whole = await spillover.readTool.execute(
        { ref: 'spillover://review-step/c1.json' },
        WORKSPACE
      )
      expect(whole).toEqual({
        success: false,
        error: `blob is ${THRESHOLD * 3} bytes; pass range {start,end} with end-start <= ${THRESHOLD}`,
      })
    })

    it('surfaces an invalid range as an error', async () => {
      const spillover = make()
      await spillover.persist({
        callId: 'c1',
        toolName: 't',
        content: blob(THRESHOLD),
        inlineBytes: THRESHOLD,
        isError: false,
      })
      const res = await spillover.readTool.execute(
        { ref: 'spillover://review-step/c1.json', range: { start: 10, end: 5 } },
        WORKSPACE
      )
      expect(res.success).toBe(false)
      expect(res.error).toContain('invalid range')
    })

    it('rejects a ref that belongs to another step', async () => {
      const other = make({ stepId: 'other-step' })
      await other.persist({
        callId: 'c1',
        toolName: 't',
        content: blob(THRESHOLD),
        inlineBytes: THRESHOLD,
        isError: false,
      })
      const res = await make().readTool.execute(
        { ref: 'spillover://other-step/c1.json' },
        WORKSPACE
      )
      expect(res).toEqual({ success: false, error: 'spillover ref is not available to this step' })
    })

    it.each(['nope', 'spillover://review-step/../x.json', 42])('rejects ref %j', async ref => {
      const res = await make().readTool.execute({ ref }, WORKSPACE)
      expect(res).toEqual({ success: false, error: 'spillover ref is not available to this step' })
    })

    it('reports a missing blob', async () => {
      const res = await make().readTool.execute(
        { ref: 'spillover://review-step/missing.json' },
        WORKSPACE
      )
      expect(res).toEqual({ success: false, error: 'spillover blob not found' })
    })

    it('describes the read limit in the tool and in its range parameter', () => {
      const tool = make().readTool
      expect(tool.name).toBe('clerum__spillover_read')
      expect(tool.description).toContain(`Reads are limited to ${THRESHOLD} bytes`)
      // Its own wording: results are stored in memory, not on disk.
      expect(tool.description).toContain('stored outside the prompt')
      expect(tool.description).not.toContain('disk')

      const firstParty = new SpilloverReadTool(
        { load: () => Promise.resolve(null) },
        {}
      ).parametersSchema() as {
        properties: { range: Record<string, unknown> } & Record<string, unknown>
      }
      // The first-party text is true for the first-party reader, which serves whole reads.
      expect(firstParty.properties.range.description).toBe(
        'Optional byte range [start, end). If omitted, returns the full content.'
      )
      const schema = tool.parameters as typeof firstParty
      expect(schema.properties.range.description).toBe(
        `Optional byte range [start, end), at most ${THRESHOLD} bytes wide; required when the ` +
          `stored result is larger than ${THRESHOLD} bytes; if omitted, the whole result is returned.`
      )
      // Everything else is the reader's schema, unchanged.
      const { description: _step, ...stepRange } = schema.properties.range
      const { description: _firstParty, ...firstPartyRange } = firstParty.properties.range
      expect(stepRange).toEqual(firstPartyRange)
      expect({ ...schema, properties: { ...schema.properties, range: null } }).toEqual({
        ...firstParty,
        properties: { ...firstParty.properties, range: null },
      })
    })
  })
})

describe('storableToolText', () => {
  it.each([
    ['one text block', [{ type: 'text', text: 'a\nb' }], 'a\nb'],
    [
      'two text blocks',
      [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
      'a\nb',
    ],
    [
      'a text block with annotations',
      [{ type: 'text', text: 'a', annotations: { priority: 1 } }],
      'a',
    ],
    ['an empty text block', [{ type: 'text', text: '' }], ''],
  ])('returns the text of %s', (_label, content, expected) => {
    expect(storableToolText(content)).toBe(expected)
  })

  it.each([
    ['an empty array', []],
    ['a string', 'text'],
    ['an object', { success: true, content: 'x' }],
    ['null', null],
    ['undefined', undefined],
    [
      'text and image blocks',
      [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'AA', mimeType: 'image/png' },
      ],
    ],
    ['a non-text block that carries text', [{ type: 'resource', text: 'a' }]],
    ['a text block without a string', [{ type: 'text', text: 1 }]],
    ['an array of strings', ['a']],
    ['an array with null', [null]],
  ])('returns null for %s', (_label, content) => {
    expect(storableToolText(content)).toBeNull()
  })
})

describe('summarizeSpilloverReadForRecord', () => {
  it('records ref and byte count without the content', () => {
    const record = summarizeSpilloverReadForRecord(
      { ref: 'spillover://s/c.json', range: { start: 0, end: 5 } },
      { success: true, content: 'héllo' }
    )
    expect(record).toEqual({ success: true, ref: 'spillover://s/c.json', bytes: 6 })
    expect(JSON.stringify(record)).not.toContain('héllo')
  })

  it('records the error on failure', () => {
    expect(
      summarizeSpilloverReadForRecord(
        { ref: 'spillover://s/c.json' },
        { success: false, error: 'spillover blob not found' }
      )
    ).toEqual({ success: false, ref: 'spillover://s/c.json', error: 'spillover blob not found' })
  })
})

async function metricTotal(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = register.getSingleMetric(name)
  if (!metric) throw new Error(`metric ${name} is not registered`)
  const { values } = await metric.get()
  return values
    .filter(v => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0)
}

describe('step read tool counter', () => {
  it('counts a read call by with_range in countStepSpilloverRead, not in the read tool', async () => {
    // The module exports are the instruments the registry serves, so the
    // first-party delta of 0 below is read from the counter a first-party
    // read would move.
    expect(register.getSingleMetric('clerum_spillover_reads_total')).toBe(clerumSpilloverReadsTotal)
    expect(register.getSingleMetric('clerum_workflow_step_spillover_reads_total')).toBe(
      clerumWorkflowStepSpilloverReadsTotal
    )
    const stepCounter = 'clerum_workflow_step_spillover_reads_total'
    const before = {
      ranged: await metricTotal(stepCounter, { with_range: 'true' }),
      whole: await metricTotal(stepCounter, { with_range: 'false' }),
      firstParty: await metricTotal('clerum_spillover_reads_total'),
    }
    const spillover = createStepSpillover({
      stepId: 'review',
      thresholdBytes: THRESHOLD,
      budgetBytes: 1048576,
    })
    if (!spillover) throw new Error('expected a spillover')
    const big = 'x'.repeat(THRESHOLD * 3)
    const fit = 'y'.repeat(THRESHOLD)
    await spillover.persist({
      callId: 'big',
      toolName: 't',
      content: big,
      inlineBytes: bytes(big),
      isError: false,
    })
    await spillover.persist({
      callId: 'fit',
      toolName: 't',
      content: fit,
      inlineBytes: bytes(fit),
      isError: false,
    })
    const ref = (id: string, stepId = 'review'): string => `spillover://${stepId}/${id}.json`
    const calls: Array<Record<string, unknown>> = [
      { ref: ref('big', 'other') },
      { ref: ref('missing'), range: { start: 0, end: 1 } },
      { ref: ref('big') },
      { ref: ref('big'), range: { start: 0, end: THRESHOLD + 1 } },
      { ref: ref('big'), range: { start: 9, end: 3 } },
      { ref: ref('big'), range: { start: 0, end: 4 } },
      { ref: ref('fit') },
    ]
    for (const args of calls) countStepSpilloverRead(args)
    expect(await metricTotal(stepCounter, { with_range: 'true' })).toBe(before.ranged + 4)
    expect(await metricTotal(stepCounter, { with_range: 'false' })).toBe(before.whole + 3)

    // The read tool itself counts nothing, on any counter, whatever its outcome.
    const counted = {
      ranged: await metricTotal(stepCounter, { with_range: 'true' }),
      whole: await metricTotal(stepCounter, { with_range: 'false' }),
    }
    const read = spillover.readTool
    const outcomes = [
      // Rejected by the reader: the only outcome that reaches its own counting.
      await read.execute({ ref: ref('big'), range: { start: 9, end: 3 } }, WORKSPACE),
      // Served.
      await read.execute({ ref: ref('big'), range: { start: 0, end: 4 } }, WORKSPACE),
      await read.execute({ ref: ref('fit') }, WORKSPACE),
    ]
    expect(outcomes.map(o => o.success)).toEqual([false, true, true])
    expect(await metricTotal(stepCounter, { with_range: 'true' })).toBe(counted.ranged)
    expect(await metricTotal(stepCounter, { with_range: 'false' })).toBe(counted.whole)
    expect(await metricTotal('clerum_spillover_reads_total')).toBe(before.firstParty)
  })
})
