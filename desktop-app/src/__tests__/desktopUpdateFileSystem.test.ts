import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileSha256, readRegularFileNoFollow } from '../desktopUpdateFileSystem.js'

describe('physical updater file reads', () => {
  let root = ''
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: false })
  })

  it('hashes all physical archive bytes and retains bounded metadata reads', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'evenfire-physical-files-'))
    const file = path.join(root, 'app.asar')
    const bytes = Buffer.alloc(256 * 1024, 0x5a)
    await writeFile(file, bytes)
    expect(await readFileSha256(file)).toBe(createHash('sha256').update(bytes).digest('hex'))
    await expect(readRegularFileNoFollow(file, 1024)).rejects.toThrow('exceeds its size limit')
    expect(await readFile(file)).toEqual(bytes)
  })

  it.skipIf(process.platform === 'win32')('rejects final-path symlinks when hashing', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'evenfire-physical-files-'))
    const file = path.join(root, 'real.asar')
    const link = path.join(root, 'link.asar')
    await writeFile(file, 'physical bytes')
    await symlink(file, link)
    await expect(readFileSha256(link)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('physical bytes')
  })
})
