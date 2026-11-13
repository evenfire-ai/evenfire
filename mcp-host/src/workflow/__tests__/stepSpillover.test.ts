import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { logger } from '../../logger'
import {
  STEP_SPILLOVER_READ_TOOL_NAME,
  type StepSpillover,
  createStepSpillover,
  removeLeftoverStepSpillover,
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
  let outputDir: string

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'step-spillover-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
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

  // Execution roots under `.spill`; each execution gets one random hex directory.
  async function executionRoots(): Promise<string[]> {
    return (await fs.readdir(path.join(outputDir, '.spill'))).sort()
  }

  // The single execution's step directory; fails when there is not exactly one.
  async function stepDir(stepId = 'review-step'): Promise<string> {
    const roots = await executionRoots()
    expect(roots).toHaveLength(1)
    expect(roots[0]).toMatch(/^[0-9a-f]{16}$/)
    return path.join(outputDir, '.spill', roots[0]!, 'spillover', stepId)
  }

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
      expect(await fs.readdir(await stepDir())).toEqual(['c1.json'])
    })

    it('gives each execution of the same step its own files', async () => {
      const a = make()
      const b = make()
      await a.persist({
        callId: 'c1',
        toolName: 't',
        content: 'A'.repeat(THRESHOLD),
        isError: false,
      })
      await b.persist({
        callId: 'c1',
        toolName: 't',
        content: 'B'.repeat(THRESHOLD),
        isError: false,
      })
      expect(await executionRoots()).toHaveLength(2)
      await b.cleanup()
      const res = await a.readTool.execute(
        { ref: 'spillover://review-step/c1.json', range: { start: 0, end: 10 } },
        outputDir
      )
      expect(res).toEqual({ success: true, content: 'A'.repeat(10) })
      expect(await executionRoots()).toHaveLength(1)
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

    it('keeps a result inline when it would take the step over its budget', async () => {
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
      expect(await fs.readdir(await stepDir())).toEqual(['c1.json'])
    })

    it('still spills a later result that fits after one stayed inline', async () => {
      const warn = vi.spyOn(logger, 'warn')
      const spillover = make({ budgetBytes: 11000 })
      const outcomes: boolean[] = []
      for (const [callId, size] of [
        ['c1', 6000],
        ['c2', 6000],
        ['c3', 4500],
      ] as const) {
        const res = await spillover.persist({
          callId,
          toolName: 't',
          content: 'b'.repeat(size),
          isError: false,
        })
        outcomes.push(res.spilled)
      }
      expect(outcomes).toEqual([true, false, true])
      expect(await fs.readdir(await stepDir())).toEqual(['c1.json', 'c3.json'])
      const budgetWarnings = warn.mock.calls.filter(([, msg]) =>
        String(msg).includes('does not fit in the step spillover budget')
      )
      expect(budgetWarnings).toHaveLength(1)
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

    it('stops trying to write for the rest of the step after one write failure', async () => {
      const warn = vi.spyOn(logger, 'warn')
      const blocker = path.join(outputDir, '.spill')
      await fs.writeFile(blocker, 'not a directory')
      const spillover = make()
      const content = 'w'.repeat(THRESHOLD * 2)
      const first = await spillover.persist({
        callId: 'c1',
        toolName: 't',
        content,
        isError: false,
      })
      expect(first).toEqual({ text: content, spilled: false })

      // The path is writable again; only the latch keeps the next result inline.
      await fs.rm(blocker)
      const second = await spillover.persist({
        callId: 'c2',
        toolName: 't',
        content,
        isError: false,
      })
      expect(second).toEqual({ text: content, spilled: false })
      expect(await exists(blocker)).toBe(false)
      const writeWarnings = warn.mock.calls.filter(([, msg]) =>
        String(msg).includes('Could not persist tool result')
      )
      expect(writeWarnings).toHaveLength(1)

      // Witness: a fresh execution spills the same content on the same output dir.
      const fresh = await make().persist({ callId: 'c1', toolName: 't', content, isError: false })
      expect(fresh.spilled).toBe(true)
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

    it('keeps results inline and writes nothing through a symlinked .spill', async () => {
      const warn = vi.spyOn(logger, 'warn')
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'step-spillover-outside-'))
      try {
        await fs.writeFile(path.join(outside, 'keepme'), 'not ours')
        await fs.symlink(outside, path.join(outputDir, '.spill'), 'dir')
        const spillover = make()
        const content = 'w'.repeat(THRESHOLD * 2)
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
        expect(first).toEqual({ text: content, spilled: false })
        expect(second).toEqual({ text: content, spilled: false })
        expect(await fs.readdir(outside)).toEqual(['keepme'])
        // Witness: the store refused the write once and latched.
        const writeWarnings = warn.mock.calls.filter(([, msg]) =>
          String(msg).includes('Could not persist tool result')
        )
        expect(writeWarnings).toHaveLength(1)
        expect(writeWarnings[0]![0]).toMatchObject({ errorCode: 'ENOTDIR' })

        await expect(spillover.cleanup()).resolves.toBeUndefined()
        expect(await fs.readdir(outside)).toEqual(['keepme'])
        expect((await fs.lstat(path.join(outputDir, '.spill'))).isSymbolicLink()).toBe(true)
      } finally {
        await fs.rm(outside, { recursive: true, force: true })
      }
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
      const res = await spillover.persist({
        callId: 'c1',
        toolName: 't',
        content: 'z'.repeat(THRESHOLD),
        isError: false,
      })
      expect(res.spilled).toBe(true)
      expect(await fs.readdir(await stepDir())).toEqual(['c1.json'])
      await spillover.cleanup()
      expect(await fs.readdir(outputDir)).toEqual([])
      await expect(spillover.cleanup()).resolves.toBeUndefined()
    })

    it('keeps .spill while another execution still holds files', async () => {
      const a = make()
      const b = make({ stepId: 'other-step' })
      const content = 'z'.repeat(THRESHOLD)
      const spilledA = await a.persist({ callId: 'c1', toolName: 't', content, isError: false })
      const spilledB = await b.persist({ callId: 'c1', toolName: 't', content, isError: false })
      expect([spilledA.spilled, spilledB.spilled]).toEqual([true, true])
      expect(await executionRoots()).toHaveLength(2)
      await a.cleanup()
      expect(await fs.readdir(await stepDir('other-step'))).toEqual(['c1.json'])
    })

    it('does not remove through a .spill that was replaced by a symlink', async () => {
      const warn = vi.spyOn(logger, 'warn')
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'step-spillover-outside-'))
      try {
        const spillover = make()
        const res = await spillover.persist({
          callId: 'c1',
          toolName: 't',
          content: 'z'.repeat(THRESHOLD),
          isError: false,
        })
        expect(res.spilled).toBe(true)
        const [executionId] = await executionRoots()
        // Another writer moves `.spill` away and links it to a directory that
        // holds an entry with this execution's name.
        await fs.rename(path.join(outputDir, '.spill'), path.join(outputDir, 'moved'))
        await fs.mkdir(path.join(outside, executionId!))
        await fs.writeFile(path.join(outside, executionId!, 'victim'), 'not ours')
        await fs.symlink(outside, path.join(outputDir, '.spill'), 'dir')

        await expect(spillover.cleanup()).resolves.toBeUndefined()
        expect(await fs.readdir(path.join(outside, executionId!))).toEqual(['victim'])
        // Witness: cleanup reached the removal and refused it.
        const removeWarnings = warn.mock.calls.filter(([, msg]) =>
          String(msg).includes('Could not remove step spillover directory')
        )
        expect(removeWarnings).toHaveLength(1)
        expect(removeWarnings[0]![0]).toMatchObject({ errorCode: 'ENOTDIR' })
      } finally {
        await fs.rm(outside, { recursive: true, force: true })
      }
    })
  })
})

describe('removeLeftoverStepSpillover', () => {
  let outputDir: string

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'step-spillover-leftover-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.chmod(outputDir, 0o700).catch(() => undefined)
    await fs.chmod(path.join(outputDir, '.spill'), 0o700).catch(() => undefined)
    await fs.rm(outputDir, { recursive: true, force: true })
  })

  async function seed(rel: string): Promise<string> {
    const file = path.join(outputDir, '.spill', rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'leftover')
    return file
  }

  it('removes execution roots and the older layout, and then .spill when empty', async () => {
    const files = [
      await seed('0123456789abcdef/spillover/review/i1c0.json'),
      await seed('spillover/review/i1c0.json'),
    ]
    for (const f of files) expect(await exists(f)).toBe(true)
    await removeLeftoverStepSpillover(outputDir)
    expect(await fs.readdir(outputDir)).toEqual([])
  })

  it('keeps entries under .spill that this feature does not write', async () => {
    await seed('0123456789abcdef/spillover/review/i1c0.json')
    // Uppercase hex differs from the seeded root in more than case, so it is a
    // separate entry on case-insensitive filesystems too.
    const kept = ['FEDCBA9876543210', '0123456789abcde', 'keep.txt', 'spillover2']
    for (const name of kept) {
      if (name.includes('.')) await seed(name)
      else await seed(`${name}/x.json`)
    }
    await removeLeftoverStepSpillover(outputDir)
    expect((await fs.readdir(path.join(outputDir, '.spill'))).sort()).toEqual([...kept].sort())
  })

  it.each([
    ['x0123456789abcdef', 'an id after another character'],
    ['0123456789abcdef1', '17 hex characters'],
    ['x0123456789abcdef1', 'an id inside a longer name'],
    ['0123456789abcdef0123456789abcdef', '32 hex characters'],
  ])('keeps %s (%s)', async name => {
    await seed('fedcba9876543210/spillover/review/i1c0.json')
    await seed(`${name}/x.json`)
    await removeLeftoverStepSpillover(outputDir)
    // The seeded execution root is gone, so the removal ran and matched ids.
    expect(await fs.readdir(path.join(outputDir, '.spill'))).toEqual([name])
  })

  it('creates nothing when there is no .spill', async () => {
    await fs.writeFile(path.join(outputDir, 'report.md'), 'artifact')
    await removeLeftoverStepSpillover(outputDir)
    expect(await fs.readdir(outputDir)).toEqual(['report.md'])
  })

  it('logs and resolves when .spill cannot be listed', async () => {
    const warn = vi.spyOn(logger, 'warn')
    await fs.writeFile(path.join(outputDir, '.spill'), 'not a directory')
    await expect(removeLeftoverStepSpillover(outputDir)).resolves.toBeUndefined()
    expect(await exists(path.join(outputDir, '.spill'))).toBe(true)
    expect(
      warn.mock.calls.filter(([, msg]) => String(msg).includes('Could not list leftover'))
    ).toHaveLength(1)
  })

  it('does not follow a symlinked .spill', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'step-spillover-outside-'))
    try {
      for (const rel of ['0123456789abcdef/x.json', 'spillover/review/i1c0.json', 'keepme']) {
        await fs.mkdir(path.dirname(path.join(outside, rel)), { recursive: true })
        await fs.writeFile(path.join(outside, rel), 'not ours')
      }
      await fs.symlink(outside, path.join(outputDir, '.spill'), 'dir')

      await expect(removeLeftoverStepSpillover(outputDir)).resolves.toBeUndefined()

      expect((await fs.readdir(outside)).sort()).toEqual([
        '0123456789abcdef',
        'keepme',
        'spillover',
      ])
      expect((await fs.lstat(path.join(outputDir, '.spill'))).isSymbolicLink()).toBe(true)
      // Witness: the removal ran and refused the link.
      const listWarnings = warn.mock.calls.filter(([, msg]) =>
        String(msg).includes('Could not list leftover')
      )
      expect(listWarnings).toHaveLength(1)
      expect(listWarnings[0]![0]).toMatchObject({ errorCode: 'ENOTDIR' })
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('warns about a .spill that is a dangling symlink and leaves it', async () => {
    const warn = vi.spyOn(logger, 'warn')
    await fs.symlink(path.join(outputDir, 'nowhere'), path.join(outputDir, '.spill'))
    await expect(removeLeftoverStepSpillover(outputDir)).resolves.toBeUndefined()
    expect((await fs.lstat(path.join(outputDir, '.spill'))).isSymbolicLink()).toBe(true)
    expect(
      warn.mock.calls.filter(([, msg]) => String(msg).includes('Could not list leftover'))
    ).toHaveLength(1)
  })

  // root ignores directory modes, so the removal would succeed.
  it.skipIf(process.getuid?.() === 0)(
    'logs, keeps going and resolves when one entry cannot be removed',
    async () => {
      const warn = vi.spyOn(logger, 'warn')
      await seed('0123456789abcdef/spillover/review/i1c0.json')
      await seed('fedcba9876543210/spillover/review/i1c0.json')
      // A read-only `.spill` makes removing its entries fail with EACCES.
      await fs.chmod(path.join(outputDir, '.spill'), 0o500)
      await expect(removeLeftoverStepSpillover(outputDir)).resolves.toBeUndefined()
      const removeWarnings = warn.mock.calls.filter(([, msg]) =>
        String(msg).includes('Could not remove leftover')
      )
      expect(removeWarnings).toHaveLength(2)
      await fs.chmod(path.join(outputDir, '.spill'), 0o700)
      expect((await fs.readdir(path.join(outputDir, '.spill'))).sort()).toEqual([
        '0123456789abcdef',
        'fedcba9876543210',
      ])
    }
  )
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
