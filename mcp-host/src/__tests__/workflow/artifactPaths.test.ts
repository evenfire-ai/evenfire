import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  ArtifactPathError,
  MAX_ARTIFACT_BYTES,
  isSafeArtifactFilename,
  openExistingArtifactFile,
  resolveExistingArtifactFile,
} from '../../workflow/artifactPaths'

describe('artifact path resolution', () => {
  let outputDir = ''
  let outsideFile = ''

  afterEach(() => {
    if (outputDir) {
      fs.rmSync(outputDir, { recursive: true, force: true })
      outputDir = ''
    }
    if (outsideFile) {
      fs.rmSync(outsideFile, { force: true })
      outsideFile = ''
    }
  })

  it('rejects traversal, slash, backslash, null byte, and empty filenames', () => {
    expect(isSafeArtifactFilename('report.md')).toBe(true)
    for (const filename of [
      '',
      '..evil',
      '../secret.md',
      'sub/report.md',
      'sub\\report.md',
      'bad\0name',
    ]) {
      expect(isSafeArtifactFilename(filename)).toBe(false)
    }
  })

  it('resolves only existing regular files under the output directory', () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-artifact-paths-'))
    fs.writeFileSync(path.join(outputDir, 'report.md'), '# ok\n')

    const artifact = resolveExistingArtifactFile(outputDir, 'report.md')

    expect(artifact.filePath).toBe(fs.realpathSync(path.join(outputDir, 'report.md')))
    expect(artifact.stat.isFile()).toBe(true)
  })

  it('rejects symlink artifacts before returning a path', () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-artifact-paths-'))
    outsideFile = path.join(os.tmpdir(), `clerum-artifact-outside-${process.pid}-${Date.now()}`)
    fs.writeFileSync(outsideFile, 'secret')
    fs.symlinkSync(outsideFile, path.join(outputDir, 'leak.md'))

    expect(() => resolveExistingArtifactFile(outputDir, 'leak.md')).toThrow(ArtifactPathError)
    try {
      resolveExistingArtifactFile(outputDir, 'leak.md')
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactPathError)
      expect((err as ArtifactPathError).status).toBe(403)
    }
  })

  it('opens listing candidates with O_NOFOLLOW before trusting artifact metadata', async () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-artifact-paths-'))
    outsideFile = path.join(os.tmpdir(), `clerum-artifact-outside-${process.pid}-${Date.now()}`)
    fs.writeFileSync(outsideFile, 'secret')
    const candidate = path.join(outputDir, 'race.md')
    fs.writeFileSync(candidate, 'safe')

    const actualFs = fs
    let openCalled = false
    let observedFlags = 0

    vi.resetModules()
    vi.doMock('fs', () => ({
      ...actualFs,
      openSync: ((file, flags, mode) => {
        if (file === candidate) {
          openCalled = true
          observedFlags = Number(flags)
          actualFs.rmSync(candidate, { force: true })
          actualFs.symlinkSync(outsideFile, candidate)
        }
        return actualFs.openSync(file, flags, mode)
      }) as typeof fs.openSync,
    }))

    try {
      const mod = await import('../../workflow/artifactPaths')
      mod.resolveExistingArtifactFile(outputDir, 'race.md')
    } catch (err) {
      expect(openCalled).toBe(true)
      expect((observedFlags & fs.constants.O_NOFOLLOW) === fs.constants.O_NOFOLLOW).toBe(true)
      expect(err).toBeInstanceOf(Error)
      expect((err as { status?: number }).status).toBe(403)
      return
    } finally {
      vi.doUnmock('fs')
      vi.resetModules()
    }
    throw new Error('expected symlink swap to be rejected')
  })

  it('rejects directories as missing artifacts', () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-artifact-paths-'))
    fs.mkdirSync(path.join(outputDir, 'nested.md'))

    try {
      resolveExistingArtifactFile(outputDir, 'nested.md')
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactPathError)
      expect((err as ArtifactPathError).status).toBe(404)
      return
    }
    throw new Error('expected directory artifact to be rejected')
  })

  it('refuses a FIFO under an artifact name at once instead of waiting for a writer', async () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-artifact-paths-'))
    const fifo = path.join(outputDir, 'pipe.md')
    execFileSync('mkfifo', [fifo])
    expect(fs.lstatSync(fifo).isFIFO()).toBe(true)
    // A blocking open would wait for a writer; this peer opens the write end
    // after RELEASE_MS, so a blocked open ends late instead of hanging the run.
    const RELEASE_MS = 1_500
    const peer = spawn(process.execPath, [
      '-e',
      `setTimeout(() => { try { require('fs').openSync(${JSON.stringify(fifo)}, ` +
        `require('fs').constants.O_WRONLY | require('fs').constants.O_NONBLOCK) } catch {} }, ${RELEASE_MS})`,
    ])
    try {
      const started = Date.now()
      let caught: unknown
      try {
        openExistingArtifactFile(outputDir, 'pipe.md')
      } catch (err) {
        caught = err
      }
      const elapsed = Date.now() - started
      expect(caught).toBeInstanceOf(ArtifactPathError)
      expect((caught as ArtifactPathError).status).toBe(404)
      expect(elapsed).toBeLessThan(RELEASE_MS / 2)
    } finally {
      peer.kill()
    }
    // The same name as a regular file opens.
    fs.rmSync(fifo)
    fs.writeFileSync(fifo, 'text')
    const opened = openExistingArtifactFile(outputDir, 'pipe.md')
    fs.closeSync(opened.fd)
    expect(opened.stat.size).toBe(4)
  })

  it('rejects artifacts over the maximum download size before opening bytes', () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-artifact-paths-'))
    const filePath = path.join(outputDir, 'huge.md')
    fs.writeFileSync(filePath, 'x')
    fs.truncateSync(filePath, MAX_ARTIFACT_BYTES + 1)

    try {
      resolveExistingArtifactFile(outputDir, 'huge.md')
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactPathError)
      expect((err as ArtifactPathError).status).toBe(413)
      return
    }
    throw new Error('expected oversized artifact to be rejected')
  })

  it('rejects helper-level traversal attempts', () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-artifact-paths-'))

    try {
      resolveExistingArtifactFile(outputDir, '../outside.md')
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactPathError)
      expect((err as ArtifactPathError).status).toBe(400)
      return
    }
    throw new Error('expected traversal artifact to be rejected')
  })

  it('opens files with a descriptor that callers can stream and close', () => {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-artifact-paths-'))
    fs.writeFileSync(path.join(outputDir, 'report.md'), '# ok\n')

    const artifact = openExistingArtifactFile(outputDir, 'report.md')
    try {
      expect(artifact.stat.size).toBe(5)
      expect(fs.readFileSync(artifact.fd, 'utf8')).toBe('# ok\n')
    } finally {
      fs.closeSync(artifact.fd)
    }
  })
})
