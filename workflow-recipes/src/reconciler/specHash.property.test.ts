import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { SPEC_HASH_ANNOTATION, computeSpecHash, stampSpecHash } from './specHash'

// Rebuild every object with its keys in reverse insertion order; arrays keep
// their order. Object.fromEntries defines own properties, so a generated
// "__proto__" key stays a key instead of replacing the prototype.
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, child]) => [key, reverseKeys(child)])
  )
}

const manifest = fc.record({
  metadata: fc.record({
    name: fc.string({ minLength: 1 }),
    labels: fc.dictionary(fc.string({ minLength: 1 }), fc.string()),
  }),
  spec: fc.jsonValue({ maxDepth: 4 }),
})

describe('computeSpecHash properties', () => {
  it('does not depend on the key order of nested objects', () => {
    fc.assert(
      fc.property(manifest, m => {
        expect(computeSpecHash(reverseKeys(m) as object)).toBe(computeSpecHash(m))
      })
    )
  })

  it('depends on the element order of arrays', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string(), { minLength: 2, maxLength: 6 }), containers => {
        const reordered = [...containers].reverse()
        expect(computeSpecHash({ spec: { containers: reordered } })).not.toBe(
          computeSpecHash({ spec: { containers } })
        )
      })
    )
  })

  it('gives a stamped manifest the hash it had before stamping', () => {
    fc.assert(
      fc.property(manifest, m => {
        const before = computeSpecHash(m)
        const stamped = JSON.parse(JSON.stringify(m)) as Parameters<typeof stampSpecHash>[0]
        expect(stampSpecHash(stamped)).toBe(before)
        expect(stamped.metadata?.annotations?.[SPEC_HASH_ANNOTATION]).toBe(before)
        expect(computeSpecHash(stamped)).toBe(before)
      })
    )
  })
})
