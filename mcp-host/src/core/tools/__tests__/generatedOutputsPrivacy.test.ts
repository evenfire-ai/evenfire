// Chat documents go to each caller's own folder: a caller never writes to,
// lists, downloads or embeds another caller's files, and a folder that cannot
// be verified is never replaced by a shared one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { generatedOutputsRoot } from '../../../agent/taskExecutor'
import { logger } from '../../../logger'
import { zipEntries } from '../../../workflow/__tests__/support/zipEntries'
import { enforceQuota } from '../../../workflow/artifactOutput'
import { INTERNAL_TOOLS } from '../../../workflow/internalTools'
import { CALLER_OUTPUTS_DIR, resolveRpcCallerOutputDir } from '../../../workspace/callerOutputs'
import { resolveCallerRootBinding } from '../../../workspace/callerRootBinding'
import { ScopedWorkspaceProvider } from '../../../workspace/scopedWorkspace'
import { deriveUserKeyFromSource } from '../../../workspace/userKey'
import { FileWriteTool } from '../fileWrite'
import { NativeToolRegistry } from '../nativeToolRegistry'

const volume = vi.hoisted(() => ({
  mode: 'roomy' as 'roomy' | 'full' | 'unmeasurable' | 'busy-shared' | 'busy-own',
}))

// A roomy volume is sized to its free space, so the disk's occupancy never
// meets the floor; a full one leaves less than the floor; an unmeasurable one
// cannot be read.
vi.mock('fs', async original => {
  const actual = await original<typeof import('fs')>()
  return {
    ...actual,
    statfsSync: (target: string, options: { bigint: true }) => {
      if (volume.mode === 'unmeasurable') {
        throw Object.assign(new Error('statfs unavailable'), { code: 'ENOSYS' })
      }
      const reading = actual.statfsSync(target, options)
      if (volume.mode === 'busy-shared' || volume.mode === 'busy-own') {
        // 4 GB, 5% (200 MB) free: under the 15% share, over the minimum.
        const busy = {
          ...reading,
          bsize: 4096n,
          blocks: 1_000_000n,
          bfree: 50_000n,
          bavail: 50_000n,
        }
        const own = volume.mode === 'busy-own' && target !== '/'
        return own ? { ...busy, blocks: 2_000_000n } : busy
      }
      return volume.mode === 'full'
        ? { ...reading, bsize: 4096n, blocks: 1000n, bfree: 100n, bavail: 100n }
        : { ...reading, blocks: reading.bavail, bfree: reading.bavail }
    },
  }
})

const UNAVAILABLE = /could not verify your private output folder/

describe('generated documents are private to their caller', () => {
  let hostBase: string
  let shared: string
  let provider: ScopedWorkspaceProvider
  const originalOutputDir = process.env.CLERUM_OUTPUT_DIR

  beforeEach(() => {
    volume.mode = 'roomy'
    hostBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-private-outputs-')))
    provider = new ScopedWorkspaceProvider(hostBase)
    // The folder chat files went to before; chat must neither write nor read it.
    shared = path.join(hostBase, 'outputs')
    fs.mkdirSync(shared)
    process.env.CLERUM_OUTPUT_DIR = shared
  })

  afterEach(() => {
    if (originalOutputDir === undefined) delete process.env.CLERUM_OUTPUT_DIR
    else process.env.CLERUM_OUTPUT_DIR = originalOutputDir
    fs.rmSync(hostBase, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  /** The caller root a Desktop user's chat task gets. */
  function rootOf(userId: string): string {
    const binding = resolveCallerRootBinding(provider, { sender: userId, channelType: 'rpc' })
    if (!binding.root) throw new Error(`no caller root: ${binding.failureCode}`)
    return binding.root
  }

  function registryFor(callerRoot: string | undefined): NativeToolRegistry {
    return new NativeToolRegistry(
      {
        workspacePath: hostBase,
        shellTimeout: 5000,
        toolTimeout: 60000,
        toolProgressInterval: 30000,
        httpAllowlist: [],
        envAllowlist: ['PATH'],
        memoryMaxSize: 1048576,
      },
      'conv-1',
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      { maxBytes: 52_428_800 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      callerRoot
    )
  }

  function markdown(callerRoot: string | undefined, filename: string, content: string) {
    return registryFor(callerRoot).get('clerum__generate_markdown')!.execute({ filename, content })
  }

  function outputsOf(callerRoot: string): string {
    return path.join(callerRoot, CALLER_OUTPUTS_DIR)
  }

  it("keeps each caller's file in their own folder, even under the same name", async () => {
    const a = rootOf('user-a')
    const b = rootOf('user-b')
    expect((await markdown(a, 'report.md', '# A\n')).is_error).toBe(false)
    expect((await markdown(b, 'report.md', '# B\n')).is_error).toBe(false)

    expect(fs.readFileSync(path.join(outputsOf(a), 'report.md'), 'utf8')).toBe('# A\n')
    expect(fs.readFileSync(path.join(outputsOf(b), 'report.md'), 'utf8')).toBe('# B\n')
    expect(fs.statSync(outputsOf(a)).mode & 0o777).toBe(0o700)
    expect(fs.readdirSync(shared)).toEqual([])
  })

  it('is found again by the download routes, keyed as the chat message was', async () => {
    const a = rootOf('user-a')
    await markdown(a, 'report.md', '# A\n')
    // A new registry, as after a restart, writes to the same folder.
    await markdown(rootOf('user-a'), 'later.md', '# later\n')

    const lookup = resolveRpcCallerOutputDir(hostBase, 'user-a')
    expect(lookup).toEqual({ dir: outputsOf(a) })
    expect(fs.readdirSync(outputsOf(a)).sort()).toEqual(['later.md', 'report.md'])
    expect(path.basename(a)).toBe(deriveUserKeyFromSource({ sender: 'user-a', channelType: 'rpc' }))
  })

  it('writes nothing when the task has no caller folder', async () => {
    const result = await markdown(undefined, 'report.md', '# lost\n')
    expect(result.is_error).toBe(true)
    expect(result.content).toMatch(UNAVAILABLE)
    expect(result.content).not.toContain(hostBase)
    expect(fs.readdirSync(shared)).toEqual([])
    expect(fs.existsSync(path.join(hostBase, 'users'))).toBe(false)
  })

  it('writes nothing through an outputs folder that is a link', async () => {
    const a = rootOf('user-a')
    const elsewhere = path.join(hostBase, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, outputsOf(a))

    const result = await markdown(a, 'report.md', '# redirected\n')
    expect(result.is_error).toBe(true)
    expect(result.content).toMatch(UNAVAILABLE)
    expect(fs.readdirSync(elsewhere)).toEqual([])
    expect(fs.readdirSync(shared)).toEqual([])
  })

  it('refuses a root that is not a managed caller root', async () => {
    const stray = path.join(hostBase, 'stray', 'caller')
    fs.mkdirSync(stray, { recursive: true })
    const result = await markdown(stray, 'report.md', '# stray\n')
    expect(result.is_error).toBe(true)
    expect(fs.existsSync(outputsOf(stray))).toBe(false)
  })

  it("does not let one caller embed another caller's image", async () => {
    const a = rootOf('user-a')
    const b = rootOf('user-b')
    const chart = await registryFor(a)
      .get('clerum__generate_chart')!
      .execute({
        filename: 'a.png',
        type: 'bar',
        data: { labels: ['x'], datasets: [{ label: 's', data: [1] }] },
      })
    expect(chart.is_error).toBe(false)

    const docx = (root: string, image: string) =>
      registryFor(root)
        .get('clerum__generate_docx')!
        .execute({ filename: 'd.docx', body: 'Report', images: [image] })
    const media = (root: string) =>
      [...zipEntries(path.join(outputsOf(root), 'd.docx')).keys()].filter(
        name => name.startsWith('word/media/') && !name.endsWith('/')
      )

    // Control: the owner embeds it.
    expect((await docx(a, 'a.png')).is_error).toBe(false)
    expect(media(a)).toHaveLength(1)

    // By name, B's folder has no such file.
    const byName = await docx(b, 'a.png')
    expect(byName.is_error).toBe(false)
    expect(byName.content).toContain("Image 'a.png' was not found in the output folder")
    expect(media(b)).toEqual([])

    // By path, out of B's folder, it is refused.
    const keyA = path.basename(a)
    for (const image of [
      `../../${keyA}/${CALLER_OUTPUTS_DIR}/a.png`,
      path.join(outputsOf(a), 'a.png'),
    ]) {
      const result = await docx(b, image)
      expect(result.is_error).toBe(true)
      expect(result.content).toMatch(/path traversal blocked/)
    }
    expect(media(b)).toEqual([])
  })

  it('does not deliver a file that did not land in the caller folder', async () => {
    const a = rootOf('user-a')
    fs.mkdirSync(outputsOf(a))
    const elsewhere = path.join(hostBase, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.writeFileSync(path.join(elsewhere, 'report.md'), '# moved\n')
    fs.symlinkSync(path.join(elsewhere, 'report.md'), path.join(outputsOf(a), 'linked.md'))
    const tool = INTERNAL_TOOLS.find(t => t.name === 'clerum__generate_markdown')!

    for (const file of [path.join(elsewhere, 'report.md'), path.join(outputsOf(a), 'linked.md')]) {
      vi.spyOn(tool, 'execute').mockResolvedValueOnce({
        success: true,
        artifact: { name: path.basename(file), path: file, format: 'md', sizeBytes: 8 },
      } as never)
      const result = await markdown(a, 'report.md', '# moved\n')
      expect(result.is_error).toBe(true)
      expect(result.content).toMatch(UNAVAILABLE)
      expect(result.attachments ?? []).toEqual([])
    }
  })

  it.skipIf(process.getuid?.() === 0)(
    'names no path when the folder cannot be written',
    async () => {
      const a = rootOf('user-a')
      await markdown(a, 'first.md', '# first\n')
      fs.chmodSync(outputsOf(a), 0o500)
      try {
        const result = await markdown(a, 'report.md', '# blocked\n')
        expect(result.is_error).toBe(true)
        expect(result.content).toContain('Could not save report.md (EACCES)')
        expect(result.content).not.toContain(hostBase)
        expect(result.content).not.toContain(path.basename(a))
      } finally {
        fs.chmodSync(outputsOf(a), 0o700)
      }
    }
  )

  it('keeps the free space of the Host volume, and removes nothing to make room', async () => {
    const a = rootOf('user-a')
    await markdown(a, 'kept.md', '# kept\n')
    volume.mode = 'full'

    const result = await markdown(a, 'report.md', '# too much\n')
    expect(result.is_error).toBe(true)
    expect(result.content).toMatch(/Not enough free space/)
    expect(fs.readdirSync(outputsOf(a))).toEqual(['kept.md'])
  })

  it('keeps only the minimum free space on the root disk in development', async () => {
    const a = rootOf('user-a')
    vi.stubEnv('CLERUM_DEV_MODE', 'true')
    try {
      volume.mode = 'busy-shared'
      expect((await markdown(a, 'shared.md', '# fine\n')).is_error).toBe(false)
      // The same reading on a volume of the Host's own keeps its 15%.
      volume.mode = 'busy-own'
      const refused = await markdown(a, 'own.md', '# refused\n')
      expect(refused.is_error).toBe(true)
      expect(refused.content).toMatch(/Not enough free space/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("keeps the volume's share on the node disk of a deployed Host", async () => {
    // A local-path volume reports the node's root disk, as the root does.
    const a = rootOf('user-a')
    vi.stubEnv('CLERUM_DEV_MODE', '')
    try {
      volume.mode = 'busy-shared'
      const refused = await markdown(a, 'node.md', '# refused\n')
      expect(refused.is_error).toBe(true)
      expect(refused.content).toMatch(/Not enough free space/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('writes when the volume cannot be measured, and says so once', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const a = rootOf('user-a')
    volume.mode = 'unmeasurable'

    expect((await markdown(a, 'one.md', '# one\n')).is_error).toBe(false)
    expect((await markdown(a, 'two.md', '# two\n')).is_error).toBe(false)
    const reports = warn.mock.calls.filter(([, message]) =>
      String(message).includes('Could not measure the Host volume')
    )
    expect(reports).toHaveLength(1)
  })

  it("leaves a workflow run's output folder without the floor", () => {
    volume.mode = 'full'
    const runOutput = path.join(hostBase, 'output')
    fs.mkdirSync(runOutput)
    const callerOutputs = outputsOf(rootOf('user-a'))
    fs.mkdirSync(callerOutputs)
    expect(() => enforceQuota(runOutput, 10)).not.toThrow()
    expect(() => enforceQuota(callerOutputs, 10)).toThrow(/Not enough free space/)
  })

  it('keeps file_write out of the folder, directly or through a link', async () => {
    const a = rootOf('user-a')
    await markdown(a, 'report.md', '# A\n')
    fs.symlinkSync(outputsOf(a), path.join(a, 'alias'))
    const write = new FileWriteTool(a)

    for (const target of [`${CALLER_OUTPUTS_DIR}/report.md`, 'alias/report.md']) {
      const result = await write.execute({ path: target, content: 'overwritten' })
      expect(result.is_error).toBe(true)
    }
    expect(fs.readFileSync(path.join(outputsOf(a), 'report.md'), 'utf8')).toBe('# A\n')
  })
})

describe('generatedOutputsRoot', () => {
  it('gives a message with no sender no folder, so its files are not shared', () => {
    expect(
      generatedOutputsRoot({ sender: '  ', channelType: 'slack' } as never, '/h/users/k')
    ).toBe(undefined)
    expect(generatedOutputsRoot({ sender: 'u1', channelType: 'rpc' } as never, '/h/users/k')).toBe(
      '/h/users/k'
    )
    // Cron and system tasks keep the reserved system folder.
    expect(generatedOutputsRoot(undefined, '/h/users/_system')).toBe('/h/users/_system')
  })
})
