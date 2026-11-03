import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isQueryValueAllowed, isQuotedValueAllowed } from '../egressProxyValueClass'

/**
 * VC-1 (spec §8.5): the TypeScript classifier must reproduce the reviewed
 * verdicts of the shared corpus for every query and quoted row. The image
 * harness reads the same file with the awk program, so a class change on either
 * side without the other fails a test instead of drifting silently.
 *
 * The corpus is the source of truth for the expected column; this test never
 * weakens a row. Its value field holds only [A-Za-z0-9] and three-digit octal
 * escapes for every other byte, so the file survives any encoding and every
 * consumer decodes the exact bytes.
 */
const CORPUS_PATH = resolve(__dirname, '../../../nginx-egress-proxy/egress-proxy-value-corpus.tsv')
const EXPECTED_ROWS = 90
const EXPECTED_ROWS_PER_CONTEXT = 45
const CONTEXTS = ['query', 'quoted'] as const

type CorpusRow = {
  context: string
  label: string
  value: Buffer
  expected: 'ACCEPT' | 'REJECT'
}

function decodeCorpusValue(field: string, lineNumber: number): Buffer {
  const bytes: number[] = []
  for (let index = 0; index < field.length; index += 1) {
    const character = field[index]
    if (character === '\\') {
      const octal = field.slice(index + 1, index + 4)
      if (!/^[0-7]{3}$/.test(octal)) {
        throw new Error(
          `corpus line ${lineNumber}: backslash must start a three-digit octal escape, got "${octal}"`
        )
      }
      bytes.push(parseInt(octal, 8))
      index += 3
      continue
    }
    if (!/^[A-Za-z0-9]$/.test(character)) {
      throw new Error(
        `corpus line ${lineNumber}: the value field holds only [A-Za-z0-9] and \\ooo escapes`
      )
    }
    bytes.push(character.charCodeAt(0))
  }
  return Buffer.from(bytes)
}

function readCorpus(): CorpusRow[] {
  let text: string
  try {
    text = readFileSync(CORPUS_PATH, 'utf8')
  } catch (error) {
    throw new Error(`corpus is missing: ${CORPUS_PATH} (${(error as Error).message})`)
  }
  const rows: CorpusRow[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '')
    if (line === '' || line.startsWith('#')) continue
    const fields = line.split('\t')
    if (fields.length !== 4) {
      throw new Error(
        `corpus line ${index + 1}: expected context/label/value/expected, got ${line}`
      )
    }
    const [context, label, value, expected] = fields
    if (context === 'context') continue // a header line, when present
    if (expected !== 'ACCEPT' && expected !== 'REJECT') {
      throw new Error(`corpus line ${index + 1}: invalid expected verdict "${expected}"`)
    }
    rows.push({ context, label, value: decodeCorpusValue(value, index + 1), expected })
  }
  return rows
}

function verdict(context: string, bytes: Uint8Array): 'ACCEPT' | 'REJECT' {
  const allowed = context === 'query' ? isQueryValueAllowed(bytes) : isQuotedValueAllowed(bytes)
  return allowed ? 'ACCEPT' : 'REJECT'
}

describe('egress-proxy value classes against the shared corpus (VC-1)', () => {
  const rows = readCorpus()
  const contextRows = rows.filter(row => (CONTEXTS as readonly string[]).includes(row.context))

  it('reads every query and quoted row of the corpus', () => {
    expect(rows.length).toBeGreaterThan(0)
    expect(contextRows).toHaveLength(EXPECTED_ROWS)
    for (const context of CONTEXTS) {
      const count = rows.filter(row => row.context === context).length
      expect(count, `${context} rows`).toBe(EXPECTED_ROWS_PER_CONTEXT)
    }
  })

  it.each(contextRows.map(row => [`${row.context}/${row.label}`, row] as const))(
    'agrees with the expected verdict of %s',
    (_id, row) => {
      expect(verdict(row.context, row.value), `${row.context}/${row.label}`).toBe(row.expected)
    }
  )

  it('rejects a NUL byte in both classes (TS-only row: environments cannot carry it)', () => {
    const nul = Buffer.from([0x61, 0x00, 0x62])
    expect(isQueryValueAllowed(nul)).toBe(false)
    expect(isQuotedValueAllowed(nul)).toBe(false)
    // Life witness: the same value without the NUL is accepted in both classes.
    const printable = Buffer.from('ab', 'utf8')
    expect(isQueryValueAllowed(printable)).toBe(true)
    expect(isQuotedValueAllowed(printable)).toBe(true)
  })

  it('applies one non-overlapping %XX pass, as the image gsub does', () => {
    // pct-double / pct-split are corpus rows; this pins the semantics that make
    // them REJECT and proves an iterative strip would differ.
    expect(isQueryValueAllowed(Buffer.from('a%%4141', 'utf8'))).toBe(false)
    expect(isQueryValueAllowed(Buffer.from('a%2%41', 'utf8'))).toBe(false)
    expect(isQueryValueAllowed(Buffer.from('a%41b', 'utf8'))).toBe(true)
  })
})
