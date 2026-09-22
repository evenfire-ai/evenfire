import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { STREAM_LIMITS } from '../src/requestLimits.js'

const fixturePath = new URL(
  '../../tests/e2e/fixtures/codex-subscription/sanitized-upstream-contract.json',
  import.meta.url
)

describe('codex-subscription stream limits freeze', () => {
  it('pins the proxy STREAM_LIMITS to the limits the fixture publishes', () => {
    // StreamGate and the stream deadline enforce these three published bounds
    // from the proxy's own constant, not from the contract package, so the
    // Codex freeze gate in tests/e2e cannot see them.
    const { limits } = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      limits: Record<string, unknown>
    }
    const streamLimits: Record<string, number> = { ...STREAM_LIMITS }
    expect(Object.keys(streamLimits).sort()).toEqual([
      'maxConcurrentStreams',
      'maxQueuedRequests',
      'maxStreamDurationMs',
    ])
    for (const name of Object.keys(streamLimits)) {
      expect({ [name]: limits[name] }).toEqual({ [name]: streamLimits[name] })
    }
  })
})
