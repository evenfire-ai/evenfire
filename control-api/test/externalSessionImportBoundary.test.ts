import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('external user-session verifier import boundary', () => {
  it('keeps low-level external-user verifiers behind the one authentication boundary', () => {
    const sourceRoot = join(process.cwd(), 'src')
    const allowed = new Set([
      'services/auth/externalSessionAuthentication.ts',
      'utils/auth/externalSessionAuthToken.ts',
      'utils/auth/userSessionV2Token.ts',
    ])
    const violations = sourceFiles(sourceRoot)
      .filter(path => {
        const local = relative(sourceRoot, path)
        if (allowed.has(local)) return false
        const source = readFileSync(path, 'utf8')
        return /\b(?:verifyExternalSessionToken|verifyUserSessionV2Token)\b/.test(source)
      })
      .map(path => relative(sourceRoot, path))

    expect(violations).toEqual([])
  })
})
