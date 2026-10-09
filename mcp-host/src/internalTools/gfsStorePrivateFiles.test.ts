/**
 * The private-object opener of the GFS download store: it never follows a
 * symlink, and it refuses an opened inode whose name moved to another inode
 * before the check finished.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as syncFs from 'node:fs'
import type * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  PrivateStoreNameMovedError,
  PrivateStoreUntrustedError,
  openPrivateStoreObject,
} from './gfsStorePrivateFiles'

const { beforeLstat } = vi.hoisted(() => ({
  beforeLstat: { hook: undefined as ((target: string) => void) | undefined },
}))
// Pass-through lstat; a test can act on the name right before the opener's
// name check, the window an atomic rename over the name would use.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>()
  return {
    ...actual,
    lstat: ((target: syncFs.PathLike, ...rest: never[]) => {
      beforeLstat.hook?.(String(target))
      return (actual.lstat as (...args: unknown[]) => Promise<unknown>)(target, ...rest)
    }) as typeof actual.lstat,
  }
})

let root: string

beforeEach(() => {
  beforeLstat.hook = undefined
  root = syncFs.mkdtempSync(path.join(tmpdir(), 'gfs-private-files-'))
})

afterEach(() => {
  beforeLstat.hook = undefined
  syncFs.rmSync(root, { recursive: true, force: true })
})

function privateFile(name: string, content: string): string {
  const target = path.join(root, name)
  syncFs.writeFileSync(target, content, { mode: 0o600 })
  return target
}

describe('openPrivateStoreObject', () => {
  it('S02: refuses a symlink at the open itself, with ELOOP', async () => {
    const target = privateFile('target', 'private bytes')
    const link = path.join(root, 'link')
    syncFs.symlinkSync(target, link)
    // Witness: the private file it points at is opened.
    const handle = await openPrivateStoreObject(target, 'file')
    await handle.close()

    await expect(openPrivateStoreObject(link, 'file')).rejects.toMatchObject({ code: 'ELOOP' })
  })

  it('S03: refuses an opened inode whose name moved to another inode', async () => {
    const target = privateFile('source', 'published bytes')
    const replacement = privateFile('replacement', 'other bytes')
    let swapped = false
    beforeLstat.hook = name => {
      if (name !== target || swapped) return
      swapped = true
      syncFs.renameSync(replacement, target)
    }

    const refusal = await openPrivateStoreObject(target, 'file').catch(error => error)

    expect(swapped).toBe(true)
    expect(refusal).toBeInstanceOf(PrivateStoreNameMovedError)
    expect(refusal).toBeInstanceOf(PrivateStoreUntrustedError)
    // Witness: without the swap the same name opens.
    beforeLstat.hook = undefined
    const handle = await openPrivateStoreObject(target, 'file')
    await handle.close()
  })
})
