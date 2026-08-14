import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type HostModelRole,
  enumerateHostModelReferences,
} from '../src/routes/admin/hostModelReferences.js'
import { offeredKey } from '../src/routes/admin/modelAllowlistTolerance.js'
import { isPlainObject } from '../src/utils/isPlainObject.js'

// Unit + property coverage for the shared Host model-reference enumeration
// (regla D4, hallazgo R1-M3). The enumeration is the single definition of "which
// spec locations reference a (provider, model) pair, and in which role", consumed
// by BOTH the live impact gate (`hostRolesReferencing` in llmModelImpact.ts) and
// the tolerance seam (`storedRoleSets` in hostSpecValidation.ts). Neither of those
// two callers is exported, so behaviour-preservation is proven by re-deriving each
// caller's shape from the shared enumeration and asserting it against an ORACLE
// that reproduces the pre-refactor inline logic verbatim (T2/T4).

const k = (provider: string, model: string) => offeredKey(provider, model)

describe('enumerateHostModelReferences — example coverage (T4)', () => {
  it('emits one entry per location, in spec order (primary, allowedModels[], fallbacks[])', () => {
    const spec = {
      model: { provider: 'claude', name: 'claude-haiku-4-5' },
      allowedModels: [
        { provider: 'openai', model: 'gpt-5' },
        { provider: 'groq', model: 'llama-4' },
      ],
      llmPolicy: { fallbacks: [{ provider: 'zai', model: 'glm-4' }] },
    }
    expect(enumerateHostModelReferences(spec)).toEqual([
      { key: k('claude', 'claude-haiku-4-5'), role: 'primary' },
      { key: k('openai', 'gpt-5'), role: 'allowedModels' },
      { key: k('groq', 'llama-4'), role: 'allowedModels' },
      { key: k('zai', 'glm-4'), role: 'fallback' },
    ])
  })

  it('emits one entry per location for a pair present in all three (no dedup here)', () => {
    const spec = {
      model: { provider: 'claude', name: 'm' },
      allowedModels: [{ provider: 'claude', model: 'm' }],
      llmPolicy: { fallbacks: [{ provider: 'claude', model: 'm' }] },
    }
    const key = k('claude', 'm')
    expect(enumerateHostModelReferences(spec)).toEqual([
      { key, role: 'primary' },
      { key, role: 'allowedModels' },
      { key, role: 'fallback' },
    ])
  })

  it('handles all absences: no model, empty allowedModels, no fallbacks', () => {
    expect(enumerateHostModelReferences({ allowedModels: [] })).toEqual([])
    expect(enumerateHostModelReferences({ llmPolicy: {} })).toEqual([])
    expect(enumerateHostModelReferences({})).toEqual([])
    expect(enumerateHostModelReferences(undefined)).toEqual([])
    expect(enumerateHostModelReferences(null)).toEqual([])
    expect(enumerateHostModelReferences('nope')).toEqual([])
    expect(enumerateHostModelReferences([])).toEqual([])
  })

  it('trims provider/model and skips malformed or partial entries', () => {
    const spec = {
      model: { provider: '  claude ', name: ' m ' },
      allowedModels: [
        { provider: 'openai', model: 'gpt-5' },
        { provider: '', model: 'x' }, // empty provider -> skip
        { provider: 'groq' }, // no model -> skip
        'not-an-object', // non-object -> skip
        { provider: 42, model: 'y' }, // non-string provider -> skip
      ],
      llmPolicy: { fallbacks: [{ provider: 'zai', model: '  glm-4' }, null] },
    }
    expect(enumerateHostModelReferences(spec)).toEqual([
      { key: k('claude', 'm'), role: 'primary' },
      { key: k('openai', 'gpt-5'), role: 'allowedModels' },
      { key: k('zai', 'glm-4'), role: 'fallback' },
    ])
  })

  it('ignores a non-array allowedModels and a non-object/absent llmPolicy', () => {
    expect(enumerateHostModelReferences({ allowedModels: { provider: 'x', model: 'y' } })).toEqual(
      []
    )
    expect(enumerateHostModelReferences({ llmPolicy: 'nope' })).toEqual([])
    expect(enumerateHostModelReferences({ llmPolicy: { fallbacks: 'nope' } })).toEqual([])
  })
})

// --- Oracles: verbatim reproduction of the PRE-refactor inline logic. ---

/** Old `storedRoleSets` from hostSpecValidation.ts (pre-R1-M3). */
function oracleStoredRoleSets(stored: unknown): {
  primary: Set<string>
  any: Set<string>
} {
  const primary = new Set<string>()
  const any = new Set<string>()
  if (!isPlainObject(stored)) return { primary, any }
  const model = stored.model
  if (
    isPlainObject(model) &&
    typeof model.name === 'string' &&
    typeof model.provider === 'string'
  ) {
    const name = model.name.trim()
    const provider = model.provider.trim()
    if (name && provider) {
      const key = offeredKey(provider, name)
      primary.add(key)
      any.add(key)
    }
  }
  const llmPolicy = stored.llmPolicy
  if (isPlainObject(llmPolicy) && Array.isArray(llmPolicy.fallbacks)) {
    for (const entry of llmPolicy.fallbacks) {
      if (!isPlainObject(entry)) continue
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
      const fbModel = typeof entry.model === 'string' ? entry.model.trim() : ''
      if (provider && fbModel) any.add(offeredKey(provider, fbModel))
    }
  }
  const allowedModels = stored.allowedModels
  if (Array.isArray(allowedModels)) {
    for (const entry of allowedModels) {
      if (!isPlainObject(entry)) continue
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
      const model2 = typeof entry.model === 'string' ? entry.model.trim() : ''
      if (provider && model2) any.add(offeredKey(provider, model2))
    }
  }
  return { primary, any }
}

/** Old `hostRolesReferencing` from llmModelImpact.ts (pre-R1-M3). */
function oracleHostRoles(spec: unknown, targetKey: string): HostModelRole[] {
  if (!isPlainObject(spec)) return []
  const roles: HostModelRole[] = []
  const model = spec.model
  if (isPlainObject(model)) {
    const name = typeof model.name === 'string' ? model.name.trim() : ''
    const provider = typeof model.provider === 'string' ? model.provider.trim() : ''
    if (name && provider && offeredKey(provider, name) === targetKey) roles.push('primary')
  }
  const allowedModels = spec.allowedModels
  if (Array.isArray(allowedModels)) {
    for (const entry of allowedModels) {
      if (!isPlainObject(entry)) continue
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
      const m = typeof entry.model === 'string' ? entry.model.trim() : ''
      if (provider && m && offeredKey(provider, m) === targetKey) {
        roles.push('allowedModels')
        break
      }
    }
  }
  const llmPolicy = spec.llmPolicy
  if (isPlainObject(llmPolicy) && Array.isArray(llmPolicy.fallbacks)) {
    for (const entry of llmPolicy.fallbacks) {
      if (!isPlainObject(entry)) continue
      const provider = typeof entry.provider === 'string' ? entry.provider.trim() : ''
      const m = typeof entry.model === 'string' ? entry.model.trim() : ''
      if (provider && m && offeredKey(provider, m) === targetKey) {
        roles.push('fallback')
        break
      }
    }
  }
  return roles
}

// --- Caller shapes derived from the shared enumeration (what the code now does). ---

function sharedStoredRoleSets(stored: unknown): { primary: Set<string>; any: Set<string> } {
  const primary = new Set<string>()
  const any = new Set<string>()
  for (const ref of enumerateHostModelReferences(stored)) {
    any.add(ref.key)
    if (ref.role === 'primary') primary.add(ref.key)
  }
  return { primary, any }
}

function sharedHostRoles(spec: unknown, targetKey: string): HostModelRole[] {
  const roles: HostModelRole[] = []
  const seen = new Set<HostModelRole>()
  for (const ref of enumerateHostModelReferences(spec)) {
    if (ref.key !== targetKey || seen.has(ref.role)) continue
    seen.add(ref.role)
    roles.push(ref.role)
  }
  return roles
}

// --- Arbitraries: specs whose fields exercise every guard (trim, wrong types,
//     absent/empty/malformed), so the property fuzzes the exact edge cases. ---

const arbProvider = fc.oneof(
  fc.constantFrom('claude', 'openai', 'groq', 'zai'),
  fc.constantFrom('  claude', 'claude  ', '', '   '),
  fc.string({ maxLength: 4 })
)
const arbModelName = fc.oneof(
  fc.constantFrom('m', 'gpt-5', 'glm 4', ' m ', '', '   '),
  fc.string({ maxLength: 4 })
)
// An entry that may be well-formed, partial, mistyped, or not an object at all.
const arbEntry = fc.oneof(
  fc.record({ provider: arbProvider, model: arbModelName }),
  fc.record({ provider: arbProvider }),
  fc.record({ model: arbModelName }),
  fc.record({ provider: fc.integer(), model: arbModelName }),
  fc.constantFrom(null, 'x', 42, undefined)
)
const arbModelObj = fc.oneof(
  fc.record({ provider: arbProvider, name: arbModelName }),
  fc.record({ name: arbModelName }),
  fc.constantFrom(null, 'x', undefined)
)
const arbAllowedModels = fc.oneof(
  fc.constant(undefined),
  fc.constant([]),
  fc.array(arbEntry, { maxLength: 5 }),
  fc.constantFrom('nope', { not: 'an-array' })
)
const arbLlmPolicy = fc.oneof(
  fc.constant(undefined),
  fc.constant('nope'),
  fc.record({ fallbacks: fc.oneof(fc.array(arbEntry, { maxLength: 5 }), fc.constant('nope')) })
)
const arbSpec = fc.record(
  { model: arbModelObj, allowedModels: arbAllowedModels, llmPolicy: arbLlmPolicy },
  { requiredKeys: [] }
)

const sortedKeys = (s: Set<string>) => [...s].sort()

describe('enumerateHostModelReferences — behaviour-preserving for both callers (T2)', () => {
  it('storedRoleSets derived from the shared enumeration equals the pre-refactor oracle', () => {
    fc.assert(
      fc.property(arbSpec, spec => {
        const shared = sharedStoredRoleSets(spec)
        const oracle = oracleStoredRoleSets(spec)
        expect(sortedKeys(shared.primary)).toEqual(sortedKeys(oracle.primary))
        expect(sortedKeys(shared.any)).toEqual(sortedKeys(oracle.any))
      }),
      { numRuns: 5000 }
    )
  })

  it('hostRolesReferencing derived from the shared enumeration equals the pre-refactor oracle (order preserved)', () => {
    fc.assert(
      fc.property(arbSpec, arbProvider, arbModelName, (spec, p, m) => {
        // Target keys drawn from both random pairs AND the spec's own emitted
        // keys, so the equality is exercised on real hits, not only misses.
        const candidateKeys = [
          offeredKey(p.trim(), m.trim()),
          ...enumerateHostModelReferences(spec).map(r => r.key),
        ]
        for (const targetKey of candidateKeys) {
          expect(sharedHostRoles(spec, targetKey)).toEqual(oracleHostRoles(spec, targetKey))
        }
      }),
      { numRuns: 5000 }
    )
  })
})
