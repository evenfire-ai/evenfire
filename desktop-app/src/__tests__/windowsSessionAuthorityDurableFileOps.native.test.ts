import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createSessionAuthorityFileDurablySync,
  renameSessionAuthorityFileDurablySync,
} from '../sessionAuthorityDurableFileOps.js'

const roots: string[] = []

function createRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'evenfire-session-authority-durable-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Windows session-authority durable file operations', () => {
  it.skipIf(process.platform !== 'win32')(
    'creates and replaces only through same-directory write-through moves',
    () => {
      const root = createRoot()
      const authority = path.join(root, 'authority.record')
      const replacement = path.join(root, 'authority.next')

      createSessionAuthorityFileDurablySync(authority, '{"revision":"first"}')
      expect(readFileSync(authority, 'utf8')).toBe('{"revision":"first"}')

      writeFileSync(replacement, '{"revision":"second"}')
      renameSessionAuthorityFileDurablySync(replacement, authority, true)
      expect(readFileSync(authority, 'utf8')).toBe('{"revision":"second"}')
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'rejects a non-replacing publication when another authority file already exists',
    () => {
      const root = createRoot()
      const authority = path.join(root, 'authority.record')
      const candidate = path.join(root, 'candidate.tmp')
      writeFileSync(authority, '{"owner":"current"}')
      writeFileSync(candidate, '{"owner":"candidate"}')

      expect(() => renameSessionAuthorityFileDurablySync(candidate, authority, false)).toThrow()
      expect(readFileSync(authority, 'utf8')).toBe('{"owner":"current"}')
      expect(readFileSync(candidate, 'utf8')).toBe('{"owner":"candidate"}')
    }
  )
})
