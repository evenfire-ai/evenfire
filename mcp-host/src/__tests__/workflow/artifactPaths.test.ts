import { afterEach, describe, expect, it, vi } from 'vitest'
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
