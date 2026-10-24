import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createSessionAuthorityFileDurablySync,
  renameSessionAuthorityFileDurablySync,
} from '../sessionAuthorityDurableFileOps.js'
import { SessionAuthorityFileMutationError } from '../windowsSessionAuthorityFileOps.js'

const roots: string[] = []

function createRoot(): string {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'evenfire-authority-file-ops-')
  )
  roots.push(root)
  return root
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

function captureMutationError(action: () => void): SessionAuthorityFileMutationError {
  try {
    action()
  } catch (error) {
    if (error instanceof SessionAuthorityFileMutationError) return error
    throw error
  }
  throw new Error('Expected session-authority file mutation to fail')
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('session-authority durable file operations', () => {
  it('creates an exclusive private file and verifies the exact published bytes', () => {
    const root = createRoot()
    const authority = path.join(root, 'authority.record')
    const contents = '{"revision":"accepted"}'

    createSessionAuthorityFileDurablySync(authority, contents)

    expect(fs.readFileSync(authority, 'utf8')).toBe(contents)
    if (process.platform !== 'win32') {
      // POSIX mode bits do not prove the Windows DACL/effective-access contract.
      expect(fs.statSync(authority).mode & 0o777).toBe(0o600)
    }
  })

  it('does not publish candidate bytes that differ from the prepared content', () => {
    const root = createRoot()
    const authority = path.join(root, 'authority.record')
    const write = fs.writeFileSync.bind(fs)
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      return write(file, data === 'approved-content' ? 'different-content' : data, options)
    })

    const error = captureMutationError(() =>
      createSessionAuthorityFileDurablySync(authority, 'approved-content')
    )

    expect(error).toMatchObject({
      outcome: 'rejected',
      diagnostic: { phase: 'file-readback-failed' },
    })
    expect(() => fs.lstatSync(authority)).toThrow()
  })

  it('removes only its temporary candidate after a rejected no-replace publication', () => {
    const root = createRoot()
    const authority = path.join(root, 'authority.record')
    fs.writeFileSync(authority, 'existing-owner', { mode: 0o600 })

    const error = captureMutationError(() =>
      createSessionAuthorityFileDurablySync(authority, 'candidate-owner')
    )

    expect(error).toMatchObject({ outcome: 'rejected', code: 'EEXIST' })
    expect(fs.readFileSync(authority, 'utf8')).toBe('existing-owner')
    expect(fs.readdirSync(root)).toEqual(['authority.record'])
  })

  it('atomically replaces the selected file and checks its source receipt on read-back', () => {
    const root = createRoot()
    const current = path.join(root, 'authority.record')
    const candidate = path.join(root, 'authority.next')
    fs.writeFileSync(current, 'previous-authority', { mode: 0o600 })
    fs.writeFileSync(candidate, 'next-authority', { mode: 0o600 })

    renameSessionAuthorityFileDurablySync(candidate, current, true)

    expect(fs.readFileSync(current, 'utf8')).toBe('next-authority')
    expect(() => fs.lstatSync(candidate)).toThrow()
  })

  // This races the POSIX linkSync publication path. Windows no-replace behavior is exercised by
  // the native MoveFileExW test, where a pre-existing destination must remain untouched.
  it('does not overwrite a destination that appears before no-replace publication', ({ skip }) => {
    if (process.platform === 'win32') skip()
    const root = createRoot()
    const current = path.join(root, 'authority.record')
    const candidate = path.join(root, 'authority.next')
    fs.writeFileSync(candidate, 'candidate', { mode: 0o600 })
    const link = fs.linkSync.bind(fs)
    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      fs.writeFileSync(destination, 'concurrent-owner', { mode: 0o600 })
      return link(source, destination)
    })

    const error = captureMutationError(() =>
      renameSessionAuthorityFileDurablySync(candidate, current, false)
    )

    expect(error).toMatchObject({ outcome: 'rejected', code: 'EEXIST' })
    expect(fs.readFileSync(current, 'utf8')).toBe('concurrent-owner')
    expect(fs.readFileSync(candidate, 'utf8')).toBe('candidate')
  })

  // This injects the POSIX renameSync failure; Windows rejection is covered by the native test.
  it('preserves the prior authority when replacement publication is rejected', ({ skip }) => {
    if (process.platform === 'win32') skip()
    const root = createRoot()
    const current = path.join(root, 'authority.record')
    const candidate = path.join(root, 'authority.next')
    fs.writeFileSync(current, 'previous-authority', { mode: 0o600 })
    fs.writeFileSync(candidate, 'candidate', { mode: 0o600 })
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw errnoError('EACCES')
    })

    const error = captureMutationError(() =>
      renameSessionAuthorityFileDurablySync(candidate, current, true)
    )

    expect(error).toMatchObject({ outcome: 'rejected', code: 'EACCES' })
    expect(fs.readFileSync(current, 'utf8')).toBe('previous-authority')
    expect(fs.readFileSync(candidate, 'utf8')).toBe('candidate')
  })

  it('rejects a source path whose identity changes before publication', () => {
    const root = createRoot()
    const current = path.join(root, 'authority.record')
    const candidate = path.join(root, 'authority.next')
    const replacedCandidate = path.join(root, 'authority.original')
    fs.writeFileSync(current, 'previous-authority', { mode: 0o600 })
    fs.writeFileSync(candidate, 'candidate', { mode: 0o600 })
    const fsync = fs.fsyncSync.bind(fs)
    vi.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
      fsync(descriptor)
      if (!fs.fstatSync(descriptor).isDirectory()) {
        fs.renameSync(candidate, replacedCandidate)
        fs.writeFileSync(candidate, 'replacement-source', { mode: 0o600 })
      }
    })

    const error = captureMutationError(() =>
      renameSessionAuthorityFileDurablySync(candidate, current, true)
    )

    expect(error).toMatchObject({ outcome: 'rejected', code: 'EIO' })
    expect(fs.readFileSync(current, 'utf8')).toBe('previous-authority')
    expect(fs.readFileSync(candidate, 'utf8')).toBe('replacement-source')
    expect(fs.readFileSync(replacedCandidate, 'utf8')).toBe('candidate')
  })

  it('rejects source durability failure before replacing the prior authority', () => {
    const root = createRoot()
    const current = path.join(root, 'authority.record')
    const candidate = path.join(root, 'authority.next')
    fs.writeFileSync(current, 'previous-authority', { mode: 0o600 })
    fs.writeFileSync(candidate, 'candidate', { mode: 0o600 })
    vi.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
      if (!fs.fstatSync(descriptor).isDirectory()) throw errnoError('EIO')
    })

    const error = captureMutationError(() =>
      renameSessionAuthorityFileDurablySync(candidate, current, true)
    )

    expect(error).toMatchObject({
      outcome: 'rejected',
      diagnostic: { phase: 'file-durability-failed' },
    })
    expect(fs.readFileSync(current, 'utf8')).toBe('previous-authority')
    expect(fs.readFileSync(candidate, 'utf8')).toBe('candidate')
  })

  // Windows uses MoveFileExW(MOVEFILE_WRITE_THROUGH), not parent-directory fsync.
  it('reports indeterminate completion when parent-directory durability fails after replace', ({
    skip,
  }) => {
    if (process.platform === 'win32') skip()
    const root = createRoot()
    const current = path.join(root, 'authority.record')
    const candidate = path.join(root, 'authority.next')
    fs.writeFileSync(current, 'previous-authority', { mode: 0o600 })
    fs.writeFileSync(candidate, 'candidate', { mode: 0o600 })
    const fsync = fs.fsyncSync.bind(fs)
    vi.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
      if (fs.fstatSync(descriptor).isDirectory()) throw errnoError('EIO')
      return fsync(descriptor)
    })

    const error = captureMutationError(() =>
      renameSessionAuthorityFileDurablySync(candidate, current, true)
    )

    expect(error).toMatchObject({
      outcome: 'indeterminate',
      diagnostic: { phase: 'directory-sync-failed' },
    })
    // The caller must re-observe this exact state; the failed durability result is not success.
    expect(fs.readFileSync(current, 'utf8')).toBe('candidate')
  })

  // This intercepts the POSIX renameSync publication, which the Windows native adapter bypasses.
  it('reports indeterminate completion if the parent directory identity changes', ({ skip }) => {
    if (process.platform === 'win32') skip()
    const root = createRoot()
    const movedRoot = `${root}-moved`
    roots.push(movedRoot)
    const current = path.join(root, 'authority.record')
    const candidate = path.join(root, 'authority.next')
    fs.writeFileSync(current, 'previous-authority', { mode: 0o600 })
    fs.writeFileSync(candidate, 'candidate', { mode: 0o600 })
    const rename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      rename(source, destination)
      if (source === candidate) {
        rename(root, movedRoot)
        fs.mkdirSync(root)
      }
    })

    const error = captureMutationError(() =>
      renameSessionAuthorityFileDurablySync(candidate, current, true)
    )

    expect(error).toMatchObject({
      outcome: 'indeterminate',
      diagnostic: { phase: 'directory-sync-failed' },
    })
    expect(fs.readFileSync(path.join(movedRoot, 'authority.record'), 'utf8')).toBe('candidate')
    expect(() => fs.lstatSync(current)).toThrow()
  })

  // This injects after POSIX renameSync; native Windows publication has its own byte read-back.
  it('reports indeterminate completion when published bytes fail exact read-back', ({ skip }) => {
    if (process.platform === 'win32') skip()
    const root = createRoot()
    const current = path.join(root, 'authority.record')
    const candidate = path.join(root, 'authority.next')
    fs.writeFileSync(current, 'previous-authority', { mode: 0o600 })
    fs.writeFileSync(candidate, 'candidate', { mode: 0o600 })
    const rename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      rename(source, destination)
      fs.writeFileSync(destination, 'mismatched-publication', { mode: 0o600 })
    })

    const error = captureMutationError(() =>
      renameSessionAuthorityFileDurablySync(candidate, current, true)
    )

    expect(error).toMatchObject({
      outcome: 'indeterminate',
      diagnostic: { phase: 'destination-readback-failed' },
    })
    expect(fs.readFileSync(current, 'utf8')).toBe('mismatched-publication')
  })

  it('rejects a symlinked parent before mutating either source or destination', () => {
    const root = createRoot()
    const realDirectory = path.join(root, 'real')
    const aliasDirectory = path.join(root, 'alias')
    fs.mkdirSync(realDirectory)
    fs.symlinkSync(realDirectory, aliasDirectory, 'dir')
    const source = path.join(aliasDirectory, 'candidate.next')
    const destination = path.join(aliasDirectory, 'authority.record')
    fs.writeFileSync(path.join(realDirectory, 'candidate.next'), 'candidate', { mode: 0o600 })

    const error = captureMutationError(() =>
      renameSessionAuthorityFileDurablySync(source, destination, false)
    )

    expect(error).toMatchObject({
      outcome: 'rejected',
      diagnostic: { phase: 'directory-validation-failed' },
    })
    expect(fs.readFileSync(path.join(realDirectory, 'candidate.next'), 'utf8')).toBe('candidate')
    expect(() => fs.lstatSync(path.join(realDirectory, 'authority.record'))).toThrow()
  })

  it('rejects an ancestor symlink before mutating the canonical directory', () => {
    const root = createRoot()
    const realParent = path.join(root, 'real')
    const aliasParent = path.join(root, 'alias')
    fs.mkdirSync(realParent)
    fs.mkdirSync(path.join(realParent, 'nested'))
    fs.symlinkSync(realParent, aliasParent, 'dir')
    const source = path.join(aliasParent, 'nested', 'candidate.next')
    const destination = path.join(aliasParent, 'nested', 'authority.record')
    fs.writeFileSync(path.join(realParent, 'nested', 'candidate.next'), 'candidate')

    const error = captureMutationError(() =>
      renameSessionAuthorityFileDurablySync(source, destination, false)
    )

    expect(error).toMatchObject({
      outcome: 'rejected',
      diagnostic: { phase: 'directory-validation-failed' },
    })
    expect(fs.readFileSync(path.join(realParent, 'nested', 'candidate.next'), 'utf8')).toBe(
      'candidate'
    )
    expect(() => fs.lstatSync(path.join(realParent, 'nested', 'authority.record'))).toThrow()
  })
})
