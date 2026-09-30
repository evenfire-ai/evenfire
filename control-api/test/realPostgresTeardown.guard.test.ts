import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A real-Postgres suite that ends a pg pool with a plain `.end()` and later runs
// pg_terminate_backend against the same database can reach a client that is
// still closing: pg-pool's end() resolves before each client's connection has
// closed, and the 57P01 the terminate sends that client is re-emitted on the
// pool as an unhandled error (#946). Such a pool must be ended through
// endPoolAndWaitForClients. The only pool a suite may still end with a plain
// `.end()` is the one that runs the terminate: its own connection is excluded
// by `pid <> pg_backend_pid()` and nothing terminates it afterwards.
//
// The rule is lexical and deliberately narrow: in each test/*.realPostgres*
// suite that contains pg_terminate_backend, every `<identifier>.end()` whose
// receiver is not the identifier that issues the terminate query is a
// violation, wherever it sits in the file (beforeAll, a test body, afterAll).

const testDir = dirname(fileURLToPath(import.meta.url))
const REAL_POSTGRES_SUITE = /\.realPostgres.*\.test\.ts$/
const TERMINATE_QUERY = /\b(\w+)\.query(?:<[^>]*>)?\(\s*`[^`]*pg_terminate_backend/g
const PLAIN_END = /\b(\w+)\.end\(\)/g

interface ScannedSuite {
  file: string
  terminators: string[]
  plainEnds: number
  violations: string[]
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

function scanSuites(): ScannedSuite[] {
  return readdirSync(testDir)
    .filter(file => REAL_POSTGRES_SUITE.test(file))
    .sort()
    .flatMap(file => {
      const source = readFileSync(join(testDir, file), 'utf8')
      if (!source.includes('pg_terminate_backend')) return []
      const terminators = [...new Set([...source.matchAll(TERMINATE_QUERY)].map(match => match[1]))]
      const plainEnds = [...source.matchAll(PLAIN_END)]
      const violations = plainEnds
        .filter(match => !terminators.includes(match[1]))
        .map(match => `${file}:${lineOf(source, match.index)} ${match[0]}`)
      return [{ file, terminators, plainEnds: plainEnds.length, violations }]
    })
}

describe('real-Postgres teardown guard (R4-L11)', () => {
  it('ends every pool other than the terminating one through endPoolAndWaitForClients', () => {
    const suites = scanSuites()

    // Witnesses: the scan reached suites that terminate backends, in each one
    // it identified the pool that runs the terminate, and it matched plain
    // `.end()` calls at all (the terminating pools' own). Without them, an
    // empty violation list would say nothing.
    expect(suites.length).toBeGreaterThan(0)
    expect(suites.filter(suite => suite.terminators.length === 0).map(suite => suite.file)).toEqual(
      []
    )
    expect(suites.reduce((sum, suite) => sum + suite.plainEnds, 0)).toBeGreaterThan(0)

    expect(suites.flatMap(suite => suite.violations)).toEqual([])
  })
})
