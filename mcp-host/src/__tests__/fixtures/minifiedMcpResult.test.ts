/**
 * F-1 — fixture witness for #731.
 *
 * These cases pass today and must keep passing after the fix; they assert
 * nothing about `heuristicCount`'s formula. Their job is to pin the two
 * properties every #731 test depends on, so the fixture cannot be replaced by
 * something that makes those tests green without a fix:
 *
 *   1. the fixture is the size it was asked for (±10%), and
 *   2. it exhibits the word/byte gap — a word count of the payload is far
 *      below its `chars / 4` size.
 *
 * Property 2 is the substitution guard. A prose payload of identical byte size
 * has roughly one word per 6 characters, so its word count lands near
 * `chars / 6` and the gap collapses; the control case below measures that
 * directly rather than asserting it in a comment.
 */
import { describe, expect, it } from 'vitest'
import { minifiedMcpResult } from './minifiedMcpResult'

/**
 * The word count `heuristicCount` performed before #731, reproduced here on
 * purpose. This suite measures a property of the PAYLOAD, so it must not call
 * the function under repair: doing so would turn F-1 red the moment the fix
 * lands — exactly when it is supposed to still be green — and the suite would
 * then be pinning the formula instead of the fixture.
 */
const wordTokens = (content: string): number => Math.floor(content.split(/\s+/).length * 1.3) + 4

/** The chars/4 byte-pair-encoding approximation, likewise computed locally. */
const byteTokens = (content: string): number => Math.ceil(content.length / 4) + 4

/** Prose of approximately `targetBytes` characters — the control payload. */
function proseOfSize(targetBytes: number): string {
  const sentence =
    'The assistant summarized the contact list and explained which records were relevant. '
  return sentence.repeat(Math.ceil(targetBytes / sentence.length)).slice(0, targetBytes)
}

describe('minifiedMcpResult (F-1 fixture witness)', () => {
  it('F-1 is deterministic for a given seed and size', () => {
    expect(minifiedMcpResult(7, 12_000)).toBe(minifiedMcpResult(7, 12_000))
    expect(minifiedMcpResult(8, 12_000)).not.toBe(minifiedMcpResult(7, 12_000))
  })

  it('F-1 reaches the requested size without overshooting by more than 10%', () => {
    for (const target of [12_000, 33_000, 35_000]) {
      const content = minifiedMcpResult(1, target)
      expect(content.length).toBeGreaterThanOrEqual(target)
      expect(content.length).toBeLessThanOrEqual(Math.ceil(target * 1.1))
    }
  })

  it('F-1 is minified: identical to its own canonical serialization', () => {
    const content = minifiedMcpResult(3, 12_000)
    // `JSON.stringify` emits no structural whitespace, so a payload equal to
    // the re-serialization of its own parse carries none either. The spaces
    // that remain are inside string values (names, titles, sentences), which is
    // what a real tool result looks like.
    expect(JSON.stringify(JSON.parse(content))).toBe(content)
    expect(content).not.toContain('\n')
  })

  it('F-1 exhibits the word/byte gap that #731 is about', () => {
    const content = minifiedMcpResult(1, 33_000)
    // The gap is the fixture's reason to exist: a word count of this payload is
    // less than a third of its byte-derived size.
    expect(wordTokens(content) * 3).toBeLessThan(byteTokens(content))
  })

  it('F-1 control: prose of the same size does NOT exhibit the gap', () => {
    const content = proseOfSize(33_000)
    // Liveness witness for the assertion above: the same two measurements on a
    // prose payload land close together, proving the previous case measures the
    // payload's shape and not a constant of either formula.
    expect(wordTokens(content) * 3).toBeGreaterThan(byteTokens(content))
  })
})
