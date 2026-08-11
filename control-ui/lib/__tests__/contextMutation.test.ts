import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { ContextSpec } from '../api'
import { buildContextUpdatePayload, contextMutationError } from '../contextMutation'

const spec = {
  contextId: 'research',
  description: 'Research tools',
  mcpServers: ['search'],
  sharedFileSystems: [],
}

const contextSpecArbitrary: fc.Arbitrary<ContextSpec> = fc.record({
  contextId: fc.string(),
  description: fc.option(fc.string(), { nil: undefined }),
  mcpServers: fc.array(fc.string(), { maxLength: 20 }),
  sharedFileSystems: fc.option(
    fc.array(fc.record({ name: fc.string(), mountPath: fc.string() }), { maxLength: 10 }),
    { nil: undefined }
  ),
})

describe('Context optimistic concurrency payloads', () => {
  it('carries the resourceVersion from the read into the complete replacement', () => {
    expect(buildContextUpdatePayload('rv-read', spec)).toEqual({
      metadata: { resourceVersion: 'rv-read' },
      spec,
    })
  })

  it('fails closed when a read has no resourceVersion', () => {
    expect(() => buildContextUpdatePayload(undefined, spec)).toThrow(/version is unavailable/i)
  })

  it('surfaces a stale-writer conflict instead of reporting a successful mutation', () => {
    const staleWrite = Object.assign(new Error('409 conflict'), { status: 409 })
    expect(contextMutationError(staleWrite, 'Failed to update connectors')).toMatch(
      /changed since it was loaded/i
    )
  })

  it('round-trips arbitrary specs by reference with a trimmed non-blank version', () => {
    fc.assert(
      fc.property(
        fc.string().filter(version => version.trim().length > 0),
        contextSpecArbitrary,
        (resourceVersion, generatedSpec) => {
          const payload = buildContextUpdatePayload(` \t${resourceVersion}\n `, generatedSpec)
          expect(payload).toEqual({
            metadata: { resourceVersion: resourceVersion.trim() },
            spec: generatedSpec,
          })
          expect(payload.spec).toBe(generatedSpec)
        }
      )
    )
  })

  it('fails closed for arbitrary missing and whitespace-only versions', () => {
    const blankVersion = fc.oneof(
      fc.constant(undefined),
      fc
        .array(fc.constantFrom(' ', '\t', '\n', '\r'), { maxLength: 30 })
        .map(parts => parts.join(''))
    )
    fc.assert(
      fc.property(blankVersion, contextSpecArbitrary, (resourceVersion, generatedSpec) => {
        expect(() => buildContextUpdatePayload(resourceVersion, generatedSpec)).toThrow(
          /version is unavailable/i
        )
      })
    )
  })

  it('maps arbitrary conflicts, ordinary errors, and non-errors to the promised copy', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (message, fallback) => {
        expect(contextMutationError({ status: 409, message }, fallback)).toMatch(
          /changed since it was loaded/i
        )
        expect(contextMutationError(new Error(message), fallback)).toBe(message)
        expect(contextMutationError({ status: 500, message }, fallback)).toBe(fallback)
      })
    )
  })
})
