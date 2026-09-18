import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTROL_API_MIGRATIONS } from '../src/db.js'

// Operator-facing errors, comments and runbooks cite control-api migrations.
// Migrations have been renumbered before (5e6c990f8), which silently turned
// bare numbers like "migration 0068" into references to unrelated schema
// changes. These checks pin every named reference to a registered version.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const REGISTERED = new Set(CONTROL_API_MIGRATIONS.map(migration => migration.version))
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.sh', '.md', '.yaml', '.yml'])
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git'])

// Matches "migration 0071_name", "migration-0048", and slash-joined lists such
// as "migrations 0095_first/0096_second". Each list item is one reference.
const REFERENCE = /\bmigrations?[ -](\d{4}(?:_[a-z0-9_]+)?(?:\/\d{4}(?:_[a-z0-9_]+)?)*)/gi

interface MigrationReference {
  location: string
  token: string
}

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : listSourceFiles(path)
    }
    return SCANNED_EXTENSIONS.has(extname(entry.name)) ? [path] : []
  })
}

function collectReferences(root: string): { files: number; references: MigrationReference[] } {
  const files = listSourceFiles(join(REPO_ROOT, root))
  const references = files.flatMap(file =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        [...line.matchAll(REFERENCE)].flatMap(match =>
          match[1].split('/').map(token => ({
            location: `${relative(REPO_ROOT, file)}:${index + 1}`,
            token,
          }))
        )
      )
  )
  return { files: files.length, references }
}

function describeReferences(references: MigrationReference[]): string[] {
  return references.map(reference => `${reference.location} ${reference.token}`)
}

describe('control-api migration references', () => {
  it('gfs-controller cites every control-api migration by its full registered version', () => {
    const { files, references } = collectReferences('gfs-controller/src')

    // Liveness witness: the probe errors, readiness errors and their tests
    // must actually be scanned, or an empty result would pass vacuously.
    expect(files).toBeGreaterThan(0)
    expect(references.length).toBeGreaterThanOrEqual(20)
    expect(
      describeReferences(references.filter(reference => !REGISTERED.has(reference.token)))
    ).toEqual([])
  })

  it.each(['control-api/src', 'deploy', 'docs', 'scripts'])(
    'named migration references in %s match a registered version',
    root => {
      const { files, references } = collectReferences(root)
      const named = references.filter(reference => reference.token.includes('_'))

      // Liveness witness: the pattern must find real references in this root.
      expect(files).toBeGreaterThan(0)
      expect(references.length).toBeGreaterThan(0)
      expect(
        describeReferences(named.filter(reference => !REGISTERED.has(reference.token)))
      ).toEqual([])
    }
  )
})
