import { describe, expect, it } from 'vitest'
import type { SecretAccess } from './resourceBuilder'
import {
  OWNER_RECIPE_LABEL_KEY,
  SHARED_LABEL_KEY,
  combineSecretAccess,
  isSecretAccessibleByRecipe,
  parseSecretOwnership,
} from './secretOwnership'

describe('parseSecretOwnership', () => {
  it('returns shared for clerum.io/shared=true', () => {
    expect(parseSecretOwnership({ [SHARED_LABEL_KEY]: 'true' })).toEqual({ kind: 'shared' })
  })

  it('returns owner-recipe with the recipe name when only owner label is set', () => {
    expect(parseSecretOwnership({ [OWNER_RECIPE_LABEL_KEY]: 'recipe-a' })).toEqual({
      kind: 'owner-recipe',
      recipeName: 'recipe-a',
    })
  })

  it('returns unlabeled when neither label is set', () => {
    expect(parseSecretOwnership({})).toEqual({ kind: 'unlabeled' })
    expect(parseSecretOwnership(undefined)).toEqual({ kind: 'unlabeled' })
  })

  it('returns unlabeled when both labels are set (fail closed on conflict)', () => {
    expect(
      parseSecretOwnership({
        [SHARED_LABEL_KEY]: 'true',
        [OWNER_RECIPE_LABEL_KEY]: 'recipe-a',
      })
    ).toEqual({ kind: 'unlabeled' })
  })

  it('ignores shared=other-string (only "true" counts)', () => {
    expect(parseSecretOwnership({ [SHARED_LABEL_KEY]: '1' })).toEqual({ kind: 'unlabeled' })
    expect(parseSecretOwnership({ [SHARED_LABEL_KEY]: 'yes' })).toEqual({ kind: 'unlabeled' })
  })
})

describe('isSecretAccessibleByRecipe', () => {
  it('grants access to any recipe when the secret is shared', () => {
    expect(isSecretAccessibleByRecipe({ [SHARED_LABEL_KEY]: 'true' }, 'recipe-a')).toBe(true)
    expect(isSecretAccessibleByRecipe({ [SHARED_LABEL_KEY]: 'true' }, 'recipe-b')).toBe(true)
  })

  it('grants access only to the named owner', () => {
    const labels = { [OWNER_RECIPE_LABEL_KEY]: 'recipe-a' }
    expect(isSecretAccessibleByRecipe(labels, 'recipe-a')).toBe(true)
    expect(isSecretAccessibleByRecipe(labels, 'recipe-b')).toBe(false)
  })

  it('denies access to unlabeled secrets — even to a recipe that "expects" them', () => {
    expect(isSecretAccessibleByRecipe({}, 'recipe-a')).toBe(false)
    expect(isSecretAccessibleByRecipe(undefined, 'recipe-a')).toBe(false)
  })

  it('denies access when both labels are set (conflict resolves to unlabeled)', () => {
    expect(
      isSecretAccessibleByRecipe(
        { [SHARED_LABEL_KEY]: 'true', [OWNER_RECIPE_LABEL_KEY]: 'recipe-a' },
        'recipe-a'
      )
    ).toBe(false)
  })
})

describe('combineSecretAccess (Issue #637 cross-namespace)', () => {
  const accessible = (...keys: string[]): SecretAccess => ({
    state: 'accessible',
    keys: new Set(keys),
  })

  it('denied wins over EVERY other state (the attack: foreign in one ns, missing in another)', () => {
    // The exact bypass: a transport workload reads the name in mcp-server (missing)
    // while a non-transport workload reads it in sandbox-recipes (foreign → denied).
    // The combined verdict MUST be denied so the non-transport pod is not rendered.
    expect(combineSecretAccess({ state: 'missing' }, { state: 'denied' }).state).toBe('denied')
    expect(combineSecretAccess({ state: 'denied' }, { state: 'missing' }).state).toBe('denied')
    expect(combineSecretAccess(accessible('k'), { state: 'denied' }).state).toBe('denied')
    expect(combineSecretAccess({ state: 'error' }, { state: 'denied' }).state).toBe('denied')
  })

  it('error wins over accessible and missing (fail closed on unverifiable ownership)', () => {
    expect(combineSecretAccess({ state: 'error' }, { state: 'missing' }).state).toBe('error')
    expect(combineSecretAccess(accessible('k'), { state: 'error' }).state).toBe('error')
  })

  it('accessible wins over missing; missing only when every namespace is missing', () => {
    expect(combineSecretAccess(accessible('k'), { state: 'missing' }).state).toBe('accessible')
    expect(combineSecretAccess({ state: 'missing' }, { state: 'missing' }).state).toBe('missing')
  })

  it('unions visible keys when accessible in multiple namespaces', () => {
    const combined = combineSecretAccess(accessible('a', 'b'), accessible('b', 'c'))
    expect(combined.state).toBe('accessible')
    expect(combined.state === 'accessible' && [...combined.keys].sort()).toEqual(['a', 'b', 'c'])
  })

  it('is order-independent (commutative on the security-relevant ranking)', () => {
    for (const pair of [
      ['denied', 'error'],
      ['error', 'accessible'],
      ['accessible', 'missing'],
    ] as const) {
      const a: SecretAccess = pair[0] === 'accessible' ? accessible('k') : { state: pair[0] }
      const b: SecretAccess = pair[1] === 'accessible' ? accessible('k') : { state: pair[1] }
      expect(combineSecretAccess(a, b).state).toBe(combineSecretAccess(b, a).state)
    }
  })
})
