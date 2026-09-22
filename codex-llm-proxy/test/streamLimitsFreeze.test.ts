import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { STREAM_LIMITS } from '../src/requestLimits.js'

const fixturePath = new URL(
  '../../tests/e2e/fixtures/codex-subscription/sanitized-upstream-contract.json',
  import.meta.url
)
const srcDir = new URL('../src/', import.meta.url)

// Every construction of a transport error in src, with its first code argument.
// UpstreamTimeoutError takes its metric kind first and its wire code second.
const TRANSPORT_ERROR_SITE =
  /new (?:CodexTransportError|UpstreamTimeoutError)\(\s*(?:'(?:idle|total)',\s*)?([^,)\s]+)/g

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
      const literal = /^'([a-z][a-z0-9_]+)'$/.exec(match[1]!)
      // A computed code cannot be checked against the taxonomy, so it fails here.
      expect(literal, `${name}: transport error code must be a string literal, got ${match[1]}`)
        .not.toBeNull()
      codes.add(literal![1]!)
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
    // plain substring count finds, including both upstream timeout codes.
    expect(constructions).toBeGreaterThanOrEqual(15)
    expect(sites).toBe(constructions)
    expect([...codes]).toEqual(
      expect.arrayContaining(['provider_unavailable', 'stream_duration_exceeded'])
    )
    const unpublished = [...codes].filter(code => !errorTaxonomy.includes(code)).sort()
    expect(unpublished, 'emitted transport codes missing from errorTaxonomy').toEqual([])
  })
})
