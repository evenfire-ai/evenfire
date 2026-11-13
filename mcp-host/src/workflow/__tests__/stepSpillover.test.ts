import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../logger'
import {
  STEP_SPILLOVER_READ_TOOL_NAME,
  type StepSpillover,
  createStepSpillover,
  resolveStepSpilloverConfig,
  summarizeSpilloverReadForRecord,
} from '../stepSpillover'

const THRESHOLD = 4096
// The read tool takes a workspace path from its caller; the step store does not use it.
const WORKSPACE = '/workspace'

describe('resolveStepSpilloverConfig', () => {
  it('defaults to enabled, 32 KiB threshold and 16 MiB budget', () => {
    expect(resolveStepSpilloverConfig({})).toEqual({
      enabled: true,
      thresholdBytes: 32768,
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
        CLERUM_WORKFLOW_TOOL_SPILLOVER_THRESHOLD: '131072',
        CLERUM_WORKFLOW_TOOL_SPILLOVER_BUDGET_BYTES: '1048576',
      })
    ).toMatchObject({ thresholdBytes: 131072, budgetBytes: 1048576 })
  })

  it.each(['abc', '4095', '1048577', '8192.5', '-1'])('ignores threshold %j', value => {
    expect(
      resolveStepSpilloverConfig({ CLERUM_WORKFLOW_TOOL_SPILLOVER_THRESHOLD: value }).thresholdBytes
    ).toBe(32768)
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
        isError: false,
      })
      expect(res).toEqual({ text: content, spilled: false })
    })

    it('never spills an error result', async () => {
      const content = 'e'.repeat(THRESHOLD * 2)
      const res = await make().persist({ callId: 'c1', toolName: 'srv__t', content, isError: true })
      expect(res).toEqual({ text: content, spilled: false })
    })

    it('never spills the read tool itself', async () => {
      const content = 'r'.repeat(THRESHOLD * 2)
      const res = await make().persist({
        callId: 'c1',
        toolName: STEP_SPILLOVER_READ_TOOL_NAME,
        content,
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
  })

  describe('readTool', () => {
    const blob = (size: number): string =>
      Array.from({ length: size }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')

    it('reads a whole blob no larger than the threshold', async () => {
      const spillover = make()
      const content = blob(THRESHOLD)
      await spillover.persist({ callId: 'c1', toolName: 't', content, isError: false })
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
      await spillover.persist({ callId: 'c1', toolName: 't', content, isError: false })
      const res = await spillover.readTool.execute(
        { ref: 'spillover://review-step/c1.json', range: { start: 100, end: 200 } },
        WORKSPACE
      )
      expect(res).toEqual({ success: true, content: content.slice(100, 200) })
    })

    it('rejects a range wider than the threshold', async () => {
      const spillover = make()
      await spillover.persist({
        callId: 'c1',
        toolName: 't',
        content: blob(THRESHOLD * 3),
        isError: false,
      })
      const res = await spillover.readTool.execute(
        { ref: 'spillover://review-step/c1.json', range: { start: 0, end: THRESHOLD + 1 } },
        WORKSPACE
      )
      expect(res.success).toBe(false)
      expect(res.error).toContain(`end-start <= ${THRESHOLD}`)
    })

    it('surfaces an invalid range as an error', async () => {
      const spillover = make()
      await spillover.persist({
        callId: 'c1',
        toolName: 't',
        content: blob(THRESHOLD),
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
      await other.persist({ callId: 'c1', toolName: 't', content: blob(THRESHOLD), isError: false })
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

    it('describes the read limit and keeps the first-party schema', () => {
      const tool = make().readTool
      expect(tool.name).toBe('clerum__spillover_read')
      expect(tool.description).toContain(`Reads are limited to ${THRESHOLD} bytes`)
      expect(tool.parameters).toMatchObject({ required: ['ref'] })
    })
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
