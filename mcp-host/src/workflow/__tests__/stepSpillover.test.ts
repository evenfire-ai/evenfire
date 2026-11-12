import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  STEP_SPILLOVER_READ_TOOL_NAME,
  type StepSpillover,
  createStepSpillover,
  resolveStepSpilloverConfig,
  summarizeSpilloverReadForRecord,
} from '../stepSpillover'

const THRESHOLD = 4096

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

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
})

describe('createStepSpillover', () => {
  let outputDir: string

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'step-spillover-'))
  })

  afterEach(async () => {
    await fs.rm(outputDir, { recursive: true, force: true })
  })

  function make(overrides: Partial<{ stepId: string; budgetBytes: number }> = {}): StepSpillover {
    const spillover = createStepSpillover({
      outputDir,
      stepId: overrides.stepId ?? 'review-step',
      thresholdBytes: THRESHOLD,
      budgetBytes: overrides.budgetBytes ?? 1048576,
    })
    if (!spillover) throw new Error('expected a spillover')
    return spillover
  }

  const stepDir = (): string => path.join(outputDir, '.spill', 'spillover', 'review-step')

  it.each(['', 'a/b', '../x', 'a.b'])('returns null for an invalid step id %j', stepId => {
    expect(createStepSpillover({ outputDir, stepId, thresholdBytes: 4096, budgetBytes: 1 })).toBe(
      null
    )
  })

  it('creates nothing on disk when constructed', async () => {
    make()
    expect(await fs.readdir(outputDir)).toEqual([])
  })

  describe('persist', () => {
    it('keeps a result under the threshold inline and writes nothing', async () => {
      const content = 'x'.repeat(THRESHOLD - 1)
      const res = await make().persist({
        callId: 'c1',
        toolName: 'srv__t',
        content,
        isError: false,
      })
      expect(res).toEqual({ text: content, spilled: false })
      expect(await fs.readdir(outputDir)).toEqual([])
    })

    it('spills a result at or above the threshold', async () => {
      const content = 'y'.repeat(THRESHOLD * 2)
      const res = await make().persist({
        callId: 'c1',
        toolName: 'srv__t',
        content,
        isError: false,
      })
      expect(res.spilled).toBe(true)
      expect(res.text.startsWith('[Result stored outside the prompt (8192 bytes).')).toBe(true)
      expect(res.text).toContain(`of at most ${THRESHOLD} bytes.]`)
      expect(res.text).toContain('"spillover_ref":"spillover://review-step/c1.json"')
      expect(await exists(path.join(stepDir(), 'c1.json'))).toBe(true)
    })

    it('never spills an error result', async () => {
      const content = 'e'.repeat(THRESHOLD * 2)
      const res = await make().persist({ callId: 'c1', toolName: 'srv__t', content, isError: true })
      expect(res).toEqual({ text: content, spilled: false })
      expect(await fs.readdir(outputDir)).toEqual([])
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

    it('keeps results inline once the step budget would be exceeded', async () => {
      const spillover = make({ budgetBytes: 10000 })
      const content = 'b'.repeat(6000)
      const first = await spillover.persist({
        callId: 'c1',
        toolName: 't',
        content,
        isError: false,
      })
      const second = await spillover.persist({
        callId: 'c2',
        toolName: 't',
        content,
        isError: false,
      })
      expect(first.spilled).toBe(true)
      expect(second).toEqual({ text: content, spilled: false })
      expect(await exists(path.join(stepDir(), 'c2.json'))).toBe(false)
    })

    it('keeps the result inline and does not throw when the output dir is not writable', async () => {
      const blocker = path.join(outputDir, 'file')
      await fs.writeFile(blocker, 'not a directory')
      const spillover = createStepSpillover({
        outputDir: blocker,
        stepId: 'review-step',
        thresholdBytes: THRESHOLD,
        budgetBytes: 1048576,
      })!
      const content = 'w'.repeat(THRESHOLD * 2)
      const res = await spillover.persist({ callId: 'c1', toolName: 't', content, isError: false })
      expect(res).toEqual({ text: content, spilled: false })
      await expect(spillover.cleanup()).resolves.toBeUndefined()
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
        outputDir
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
        outputDir
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
        outputDir
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
        outputDir
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
        outputDir
      )
      expect(res.success).toBe(false)
      expect(res.error).toContain('invalid range')
    })

    it('rejects a ref that belongs to another step', async () => {
      const other = make({ stepId: 'other-step' })
      await other.persist({ callId: 'c1', toolName: 't', content: blob(THRESHOLD), isError: false })
      const res = await make().readTool.execute(
        { ref: 'spillover://other-step/c1.json' },
        outputDir
      )
      expect(res).toEqual({ success: false, error: 'spillover ref is not available to this step' })
    })

    it.each(['nope', 'spillover://review-step/../x.json', 42])('rejects ref %j', async ref => {
      const res = await make().readTool.execute({ ref }, outputDir)
      expect(res).toEqual({ success: false, error: 'spillover ref is not available to this step' })
    })

    it('reports a missing blob', async () => {
      const res = await make().readTool.execute(
        { ref: 'spillover://review-step/missing.json' },
        outputDir
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

  describe('cleanup', () => {
    it('does not touch the disk when nothing was spilled', async () => {
      await fs.mkdir(path.join(outputDir, '.spill'))
      await make().cleanup()
      expect(await exists(path.join(outputDir, '.spill'))).toBe(true)
    })

    it('removes the step directory and empty parents, and is idempotent', async () => {
      const spillover = make()
      await spillover.persist({
        callId: 'c1',
        toolName: 't',
        content: 'z'.repeat(THRESHOLD),
        isError: false,
      })
      await spillover.cleanup()
      expect(await fs.readdir(outputDir)).toEqual([])
      await expect(spillover.cleanup()).resolves.toBeUndefined()
    })

    it('keeps parents that still hold another step', async () => {
      const a = make()
      const b = make({ stepId: 'other-step' })
      const content = 'z'.repeat(THRESHOLD)
      await a.persist({ callId: 'c1', toolName: 't', content, isError: false })
      await b.persist({ callId: 'c1', toolName: 't', content, isError: false })
      await a.cleanup()
      expect(await fs.readdir(path.join(outputDir, '.spill', 'spillover'))).toEqual(['other-step'])
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
