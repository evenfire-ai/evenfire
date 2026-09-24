import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { STREAM_LIMITS } from '../src/requestLimits.js'

const fixturePath = new URL(
  '../../tests/e2e/fixtures/codex-subscription/sanitized-upstream-contract.json',
  import.meta.url
)
const srcDir = new URL('../src/', import.meta.url)

// Every construction of a transport error in src. UpstreamTimeoutError takes
// its metric kind first and its wire code second.
const TRANSPORT_ERROR_SITE = /new (CodexTransportError|UpstreamTimeoutError)\(/g
const CODE_LITERAL = /^'([a-z][a-z0-9_]+)'$/
// A code chosen between two literals, e.g. `kind === 'size' ? 'a' : 'b'`.
const CODE_TERNARY = /^[^?]+\?\s*'([a-z][a-z0-9_]+)'\s*:\s*'([a-z][a-z0-9_]+)'$/

// Splits the call's top-level arguments, skipping over string contents and
// nested brackets, and stops at the closing parenthesis of the call.
function callArguments(source: string, openParen: number): string[] {
  const args: string[] = []
  let depth = 0
  let start = openParen + 1
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]!
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i += 1; source[i] !== ch; i += 1) if (source[i] === '\\') i += 1
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1
    } else if (depth > 0 && (ch === ')' || ch === ']' || ch === '}')) {
      depth -= 1
    } else if (depth === 0 && (ch === ',' || ch === ')')) {
      args.push(source.slice(start, i).trim())
      if (ch === ')') return args
      start = i + 1
    }
  }
  throw new Error(`unterminated call at offset ${openParen}`)
}

function emittedTransportCodes(): { codes: Set<string>; sites: number; constructions: number } {
  const codes = new Set<string>()
  let sites = 0
  let constructions = 0
  for (const name of readdirSync(srcDir).filter(file => file.endsWith('.ts'))) {
    const source = readFileSync(new URL(name, srcDir), 'utf8')
    constructions +=
      source.split('new CodexTransportError(').length - 1 +
      source.split('new UpstreamTimeoutError(').length - 1
    for (const match of source.matchAll(TRANSPORT_ERROR_SITE)) {
      const args = callArguments(source, match.index! + match[0].length - 1)
      const code = args[match[1] === 'UpstreamTimeoutError' ? 1 : 0] ?? ''
      const literal = CODE_LITERAL.exec(code)
      const ternary = CODE_TERNARY.exec(code)
      // Any other computed code cannot be checked against the taxonomy, so it fails here.
      expect(
        literal ?? ternary,
        `${name}: transport error code must be a string literal or a choice of two, got ${code}`
      ).not.toBeNull()
      if (literal) codes.add(literal[1]!)
      if (ternary) codes.add(ternary[1]!).add(ternary[2]!)
      sites += 1
    }
  }
  return { codes, sites, constructions }
}

describe('codex-subscription stream limits freeze', () => {
  it('pins the proxy STREAM_LIMITS to the limits the fixture publishes', () => {
    // StreamGate and the upstream deadlines enforce these published bounds
    // from the proxy's own constant, not from the contract package, so the
    // Codex freeze gate in tests/e2e cannot see them.
    const { limits } = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      limits: Record<string, unknown>
    }
    const streamLimits: Record<string, number> = { ...STREAM_LIMITS }
    expect(Object.keys(streamLimits).sort()).toEqual([
      'maxConcurrentStreams',
      'maxQueueWaitMs',
      'maxQueuedRequests',
      'maxStreamDurationMs',
      'upstreamIdleTimeoutMs',
    ])
    for (const name of Object.keys(streamLimits)) {
      expect({ [name]: limits[name] }).toEqual({ [name]: streamLimits[name] })
    }
  })

  it('publishes every transport error code the proxy emits in the fixture errorTaxonomy', () => {
    const { errorTaxonomy } = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      errorTaxonomy: string[]
    }
    const { codes, sites, constructions } = emittedTransportCodes()
    // Liveness witness: the pattern read the code of every construction a
    // plain substring count finds, including both upstream timeout codes and
    // payload_too_large, which src only emits from a two-literal choice.
    expect(constructions).toBeGreaterThanOrEqual(15)
    expect(sites).toBe(constructions)
    expect([...codes]).toEqual(
      expect.arrayContaining([
        'provider_unavailable',
        'stream_duration_exceeded',
        'payload_too_large',
      ])
    )
    const unpublished = [...codes].filter(code => !errorTaxonomy.includes(code)).sort()
    expect(unpublished, 'emitted transport codes missing from errorTaxonomy').toEqual([])
  })
})
