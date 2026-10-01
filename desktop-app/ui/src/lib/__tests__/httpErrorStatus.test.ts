import { describe, expect, it } from 'vitest'
import { httpErrorStatus, isAuthorizationError } from '../format'

describe('httpErrorStatus labeled-status boundary (NEW-dui-4)', () => {
  it.each([
    ['request to status401 failed', undefined],
    ['upstream support-http500 refused the call', undefined],
    ['status 503 from upstream', 503],
    ['upstream returned status: 429', 429],
    ['request failed (status=404)', 404],
    ['upstream http status 502', 502],
    ['proxy error, status code 504', 504],
  ])('parses %j as %s', (message, expected) => {
    expect(httpErrorStatus(new Error(message))).toBe(expected)
  })

  it('never reads a status out of a waking or draining Host reference', () => {
    const waking = new Error('host_waking: agent host "status401" is waking up — retry shortly')
    const draining = new Error('host_draining: agent host "status403" is draining — retry shortly')

    expect(httpErrorStatus(waking)).toBeUndefined()
    expect(isAuthorizationError(waking)).toBe(false)
    expect(httpErrorStatus(draining)).toBeUndefined()
    // Liveness witness: the same Host reference outside the availability
    // projection still reaches the parser, which reads the real status.
    expect(httpErrorStatus(new Error('403 Forbidden: agent host "status401"'))).toBe(403)
  })
})

describe('httpErrorStatus bounded parsing (NEW-sec-2)', () => {
  it('finishes a 40k whitespace run after a status label quickly', () => {
    const hostile = new Error(`upstream status${' '.repeat(40_000)}x`)

    const startedAt = performance.now()
    const status = httpErrorStatus(hostile)
    const elapsedMs = performance.now() - startedAt

    expect(status).toBeUndefined()
    expect(elapsedMs).toBeLessThan(200)
    // Liveness witness: an ordinary labeled message still parses.
    expect(httpErrorStatus(new Error('upstream status: 503'))).toBe(503)
  })

  it('reads only the leading 2 KB of a message', () => {
    const padding = 'x'.repeat(3000)

    expect(httpErrorStatus(new Error(`${padding} status 500`))).toBeUndefined()
    // Liveness witness: the same label inside the bound is parsed.
    expect(httpErrorStatus(new Error(`${'x'.repeat(100)} status 500`))).toBe(500)
  })
})
