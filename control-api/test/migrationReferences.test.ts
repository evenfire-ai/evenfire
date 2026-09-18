import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTROL_API_MIGRATIONS } from '../src/db.js'

// Operator-facing errors, comments and runbooks cite control-api migrations.
// Migrations have been renumbered before (5e6c990f8), which silently turned
// bare numbers like "migration 0068" into references to unrelated schema
// changes. These checks pin every version-shaped token to a registered
// version, and forbid bare numbers in gfs-controller, which cites control-api
// migrations across a service boundary.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const REGISTERED = new Set(CONTROL_API_MIGRATIONS.map(migration => migration.version))
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.sh', '.md', '.yaml', '.yml'])
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git'])
// control-api/test is not scanned: it holds seed fixtures and legacy-name
// lists that are version-shaped on purpose.
const SCANNED_ROOTS = ['gfs-controller/src', 'control-api/src', 'deploy', 'docs', 'scripts']

// Registered versions are four digits ("0071") or hex-style ("00a4").
const NUMBER = String.raw`(?:\d{4}|00[a-f]\d)`
const VERSION_TOKEN = new RegExp(String.raw`(?<![0-9A-Za-z_])${NUMBER}_[a-z][a-z0-9_]*`, 'g')
// Superseded names that the runner still accepts as already applied. Only
// tokens inside a legacyVersions array are exempt; the same name anywhere else
// is a stale reference.
const LEGACY_VERSIONS_ARRAY = /legacyVersions:\s*\[[^\]]*\]/g
// "migration(s)" followed by a list of versions, across line breaks and
// separators such as ":", "`", "(", ",", "/", "and", "or".
const MIGRATION_LIST = new RegExp(
  String.raw`\bmigrations?\b((?:[\s:\`#(),/-]+|\b(?:and|or)\b|${NUMBER}(?:_[a-z][a-z0-9_]*)?(?![0-9A-Za-z_]))+)`,
  'gi'
)
const BARE_NUMBER = new RegExp(String.raw`(?<![0-9A-Za-z_])${NUMBER}(?![0-9A-Za-z_])`, 'g')

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

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

function legacySpans(text: string): Array<[number, number]> {
  return [...text.matchAll(LEGACY_VERSIONS_ARRAY)].map(match => [
    match.index,
    match.index + match[0].length,
  ])
}

function versionTokens(text: string): Array<{ index: number; token: string }> {
  const spans = legacySpans(text)
  return [...text.matchAll(VERSION_TOKEN)]
    .filter(match => !spans.some(([start, end]) => match.index >= start && match.index < end))
    .map(match => ({ index: match.index, token: match[0] }))
}

function bareNumbers(text: string): Array<{ index: number; token: string }> {
  return [...text.matchAll(MIGRATION_LIST)].flatMap(list => {
    const listStart = list.index + list[0].length - list[1].length
    return [...list[1].matchAll(BARE_NUMBER)].map(bare => ({
      index: listStart + bare.index,
      token: bare[0],
    }))
  })
}

function scan(
  root: string,
  find: (text: string) => Array<{ index: number; token: string }>
): { files: number; references: MigrationReference[] } {
  const files = listSourceFiles(join(REPO_ROOT, root))
  const references = files.flatMap(file => {
    const text = readFileSync(file, 'utf8')
    return find(text).map(({ index, token }) => ({
      location: `${relative(REPO_ROOT, file)}:${lineOf(text, index)}`,
      token,
    }))
  })
  return { files: files.length, references }
}

function describeReferences(references: MigrationReference[]): string[] {
  return references.map(reference => `${reference.location} ${reference.token}`)
}

describe('control-api migration references', () => {
  it('detects bare numbers in every citation shape the guard relies on', () => {
    expect(
      [
        'control-api migration 0068 not applied',
        'migration: 0068',
        'migration `0068`',
        'migration\n   0068',
        'migrations 0095_first, 0096 and 00a4',
        'migrations 0095_first/0096',
      ].map(sample => bareNumbers(sample).map(bare => bare.token))
    ).toEqual([['0068'], ['0068'], ['0068'], ['0068'], ['0096', '00a4'], ['0096']])
    expect(
      bareNumbers('migration 0071_gfs_immutable_blob_generations not applied, or 0074_x')
    ).toEqual([])
  })

  it('exempts only tokens inside a legacyVersions array', () => {
    const text = [
      "legacyVersions: [\n  '0055_governed_trace_runtime_roles',\n],",
      '// replaced by migration 0055_governed_trace_runtime_roles',
    ].join('\n')
    expect(versionTokens(text).map(found => found.token)).toEqual([
      '0055_governed_trace_runtime_roles',
    ])
    expect(versionTokens(text)[0].index).toBeGreaterThan(text.indexOf('],'))
  })

  it.each(SCANNED_ROOTS)('every version token in %s is a registered migration', root => {
    const { files, references } = scan(root, versionTokens)

    // Liveness witness: each root cites real versions today, so an empty
    // result means the scan stopped reading files, not that they are clean.
    expect(files).toBeGreaterThan(0)
    expect(references.length).toBeGreaterThan(0)
    expect(
      describeReferences(references.filter(reference => !REGISTERED.has(reference.token)))
    ).toEqual([])
  })

  it('gfs-controller never cites a control-api migration by bare number', () => {
    const { references } = scan('gfs-controller/src', bareNumbers)
    const { references: named } = scan('gfs-controller/src', versionTokens)

    // Liveness witness: gfs-controller cites named migrations, so the files
    // this check reads are the ones that carry migration citations.
    expect(named.length).toBeGreaterThan(0)
    expect(describeReferences(references)).toEqual([])
  })
})
