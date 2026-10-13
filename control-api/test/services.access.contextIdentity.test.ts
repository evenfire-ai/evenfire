import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { K8sGateway } from '../src/k8s.js'
import {
  type ContextCR,
  type ContextRefInput,
  type ContextRefResolution,
  allowedServerNames,
  contextResourceKey,
  loadContextResolution,
  refKey,
  resolveContextRefs,
} from '../src/services/access/contextIdentity.js'

/**
 * PR #1004 R2 — Context identity. A Host / McpServer `contextRef` names the
 * Context RESOURCE (`metadata.name`), exactly as host-context-controller reads
 * it (`getNamespacedCustomObject({ name: contextRef })`). Only a legacy
 * `user_contexts.context_id` may still be the wire `spec.contextId` alias, and
 * only when that alias is unambiguous. A reference resolves to at most one
 * resource; an unresolved reference fails closed.
 */

const NS = 'mcp-server'

function context(
  name: string,
  contextId: string,
  mcpServers: unknown[] = [],
  metadata: { namespace?: string; deletionTimestamp?: string } = {}
): ContextCR {
  return { metadata: { name, ...metadata }, spec: { contextId, mcpServers } }
}

function resolveOne(contexts: ContextCR[], input: ContextRefInput): ContextRefResolution {
  const result = resolveContextRefs(contexts, [input], { namespace: NS }).get(refKey(input))
  if (!result) throw new Error('missing resolution entry')
  return result
}

const resourceName = (r: ContextRefResolution): string | null =>
  r.resource ? contextResourceKey(r.resource) : null
const reason = (r: ContextRefResolution): string | null => (r.resource ? null : r.reason)

describe('refKey', () => {
  it('keeps the same string from different origins apart', () => {
    expect(refKey({ ref: 'ctx-a', origin: 'host' })).not.toBe(
      refKey({ ref: 'ctx-a', origin: 'legacy' })
    )
  })
})

describe('resolveContextRefs — host and server refs resolve by resource name only', () => {
  it.each(['host', 'server'] as const)(
    'a %s ref resolves the resource whose name differs from its wire id',
    origin => {
      const r = resolveOne([context('ctx-a', 'ctx-wire-a')], { ref: 'ctx-a', origin })
      expect(resourceName(r)).toBe('ctx-a')
      expect(r.resource && r.matchedBy).toBe('name')
    }
  )

  it.each(['host', 'server'] as const)('a %s ref never hops through a wire id', origin => {
    const r = resolveOne([context('ctx-a', 'ctx-wire-a')], { ref: 'ctx-wire-a', origin })
    expect(reason(r)).toBe('missing')
  })

  it('a Host ref resolves its own resource even when another resource carries it as contextId', () => {
    const contexts = [context('ctx-a', 'ctx-wire-a'), context('ctx-b', 'ctx-a')]
    const r = resolveOne(contexts, { ref: 'ctx-a', origin: 'host' })
    expect(resourceName(r)).toBe('ctx-a')
  })

  it("a Host ref whose only match is another resource's contextId is missing (no fallback)", () => {
    const r = resolveOne([context('ctx-b', 'ctx-a')], { ref: 'ctx-a', origin: 'host' })
    expect(reason(r)).toBe('missing')
  })

  it('two resources listed with the same name are a duplicate_name, never merged', () => {
    const contexts = [context('ctx-a', 'w1', ['x']), context('ctx-a', 'w2', ['y'])]
    expect(reason(resolveOne(contexts, { ref: 'ctx-a', origin: 'host' }))).toBe('duplicate_name')
    expect(reason(resolveOne(contexts, { ref: 'ctx-a', origin: 'legacy' }))).toBe('duplicate_name')
  })
})

describe('resolveContextRefs — legacy refs', () => {
  it('resolves by resource name first', () => {
    const r = resolveOne([context('ctx-a', 'ctx-wire-a')], { ref: 'ctx-a', origin: 'legacy' })
    expect(resourceName(r)).toBe('ctx-a')
    expect(r.resource && r.matchedBy).toBe('name')
  })

  it('resolves a unique wire contextId alias', () => {
    const r = resolveOne([context('ctx-a', 'ctx-wire-a')], { ref: 'ctx-wire-a', origin: 'legacy' })
    expect(resourceName(r)).toBe('ctx-a')
    expect(r.resource && r.matchedBy).toBe('contextId')
  })

  it('an alias shared by two resources is ambiguous_alias', () => {
    const contexts = [context('ctx-a', 'wire'), context('ctx-b', 'wire')]
    expect(reason(resolveOne(contexts, { ref: 'wire', origin: 'legacy' }))).toBe('ambiguous_alias')
  })

  it('a ref naming one resource and aliasing another is alias_collision', () => {
    const contexts = [context('ctx-a', 'ctx-wire-a'), context('ctx-b', 'ctx-a')]
    expect(reason(resolveOne(contexts, { ref: 'ctx-a', origin: 'legacy' }))).toBe('alias_collision')
  })

  it('a resource whose name equals its own contextId is not a collision', () => {
    const r = resolveOne([context('ctx-a', 'ctx-a')], { ref: 'ctx-a', origin: 'legacy' })
    expect(resourceName(r)).toBe('ctx-a')
  })

  it('no name and no alias match is missing', () => {
    expect(reason(resolveOne([context('ctx-a', 'w')], { ref: 'nope', origin: 'legacy' }))).toBe(
      'missing'
    )
  })
})

describe('resolveContextRefs — eligibility', () => {
  it.each(['host', 'server', 'legacy'] as const)(
    'a terminating resource named by a %s ref is ineligible and never hops to an alias',
    origin => {
      const contexts = [
        context('ctx-a', 'ctx-wire-a', ['x'], { deletionTimestamp: '2026-10-01T00:00:00Z' }),
        // An eligible resource whose wire id equals the terminating name must not
        // stand in for it.
        context('ctx-b', 'ctx-a', ['y']),
      ]
      expect(reason(resolveOne(contexts, { ref: 'ctx-a', origin }))).toBe('ineligible')
    }
  )

  it('a resource from a foreign namespace is ineligible and never an alias target', () => {
    const contexts = [context('ctx-a', 'ctx-wire-a', ['x'], { namespace: 'elsewhere' })]
    expect(reason(resolveOne(contexts, { ref: 'ctx-a', origin: 'host' }))).toBe('ineligible')
    expect(reason(resolveOne(contexts, { ref: 'ctx-wire-a', origin: 'legacy' }))).toBe('missing')
  })

  it('a resource in the expected namespace is eligible', () => {
    const contexts = [context('ctx-a', 'w', [], { namespace: NS })]
    expect(resourceName(resolveOne(contexts, { ref: 'ctx-a', origin: 'host' }))).toBe('ctx-a')
  })

  it('a terminating resource is not an alias target', () => {
    const contexts = [context('ctx-a', 'wire', [], { deletionTimestamp: '2026-10-01T00:00:00Z' })]
    expect(reason(resolveOne(contexts, { ref: 'wire', origin: 'legacy' }))).toBe('missing')
  })

  it('a resource without metadata.name is never resolved', () => {
    const contexts: ContextCR[] = [{ spec: { contextId: 'ctx-a', mcpServers: ['x'] } }]
    expect(reason(resolveOne(contexts, { ref: 'ctx-a', origin: 'host' }))).toBe('missing')
    expect(reason(resolveOne(contexts, { ref: 'ctx-a', origin: 'legacy' }))).toBe('missing')
  })
})

describe('resolveContextRefs — listing order cannot change a result (property)', () => {
  const NAMES = ['ctx-a', 'ctx-b', 'ctx-c']
  const WIRE = ['ctx-a', 'ctx-b', 'ctx-c', 'wire-1', 'wire-2']

  it('every ref resolves identically under any permutation of the listing', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            name: fc.constantFrom(...NAMES),
            contextId: fc.constantFrom(...WIRE),
            state: fc.constantFrom('ok', 'ok', 'deleting', 'foreign'),
          }),
          { maxLength: 6 }
        ),
        fc.func(fc.integer()),
        (specs, rank) => {
          const contexts = specs.map((s, i) =>
            context(s.name, s.contextId, [`srv-${i}`], {
              ...(s.state === 'deleting' ? { deletionTimestamp: '2026-10-01T00:00:00Z' } : {}),
              ...(s.state === 'foreign' ? { namespace: 'elsewhere' } : {}),
            })
          )
          const shuffled = contexts
            .map((c, i) => ({ c, k: rank(i) }))
            .sort((a, b) => a.k - b.k)
            .map(({ c }) => c)
          const refs: ContextRefInput[] = []
          for (const ref of WIRE) {
            for (const origin of ['host', 'legacy', 'server'] as const) refs.push({ ref, origin })
          }
          const a = resolveContextRefs(contexts, refs, { namespace: NS })
          const b = resolveContextRefs(shuffled, refs, { namespace: NS })
          for (const ref of refs) {
            const x = a.get(refKey(ref))!
            const y = b.get(refKey(ref))!
            expect(reason(y)).toBe(reason(x))
            // Same resource object (not merely the same name) — so a duplicate
            // can never let order pick an allowlist.
            expect(y.resource).toBe(x.resource)
          }
        }
      ),
      { numRuns: 300 }
    )
  })
})

describe('allowedServerNames', () => {
  it('trims names and drops blanks and non-strings', () => {
    const names = allowedServerNames(context('c', 'c', [' gdrive ', '', '  ', 7, null, 'notion']))
    expect([...names].sort()).toEqual(['gdrive', 'notion'])
  })

  it('tolerates a missing allowlist', () => {
    expect(allowedServerNames({ metadata: { name: 'c' } }).size).toBe(0)
  })
})

describe('loadContextResolution', () => {
  it('lists Contexts once, in the given namespace', async () => {
    const listResource = vi.fn(async () => [context('ctx-a', 'w')])
    const gateway = { listResource } as unknown as K8sGateway
    const result = await loadContextResolution(gateway, NS, [
      { ref: 'ctx-a', origin: 'host' },
      { ref: 'w', origin: 'legacy' },
    ])
    expect(listResource).toHaveBeenCalledTimes(1)
    expect(listResource).toHaveBeenCalledWith('contexts', NS)
    expect(resourceName(result.get(refKey({ ref: 'w', origin: 'legacy' }))!)).toBe('ctx-a')
  })

  it('does no I/O for no refs', async () => {
    const listResource = vi.fn()
    const result = await loadContextResolution({ listResource } as unknown as K8sGateway, NS, [])
    expect(result.size).toBe(0)
    expect(listResource).not.toHaveBeenCalled()
  })

  it('treats a malformed list response as no Contexts', async () => {
    const gateway = { listResource: vi.fn(async () => null) } as unknown as K8sGateway
    const result = await loadContextResolution(gateway, NS, [{ ref: 'ctx-a', origin: 'host' }])
    expect(reason(result.get(refKey({ ref: 'ctx-a', origin: 'host' }))!)).toBe('missing')
  })

  it('propagates a list failure', async () => {
    const gateway = {
      listResource: vi.fn(async () => {
        throw new Error('apiserver down')
      }),
    } as unknown as K8sGateway
    await expect(
      loadContextResolution(gateway, NS, [{ ref: 'ctx-a', origin: 'host' }])
    ).rejects.toThrow('apiserver down')
  })
})
