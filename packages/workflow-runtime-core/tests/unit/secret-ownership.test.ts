import { describe, expect, it } from 'vitest'
import {
  OWNER_RECIPE_LABEL_KEY,
  SHARED_LABEL_KEY,
  isSecretAccessibleByRecipe,
  parseSecretOwnership,
} from '../../src/secret-ownership'

describe('secret-ownership (Issue #637 single source of truth)', () => {
  it('exposes the canonical label keys', () => {
    expect(OWNER_RECIPE_LABEL_KEY).toBe('clerum.io/owner-recipe')
    expect(SHARED_LABEL_KEY).toBe('clerum.io/shared')
  })

  describe('parseSecretOwnership', () => {
    it('classifies shared', () => {
      expect(parseSecretOwnership({ [SHARED_LABEL_KEY]: 'true' })).toEqual({ kind: 'shared' })
    })
    it('classifies owner-recipe', () => {
      expect(parseSecretOwnership({ [OWNER_RECIPE_LABEL_KEY]: 'recipe-a' })).toEqual({
        kind: 'owner-recipe',
        recipeName: 'recipe-a',
      })
    })
    it('treats no labels as unlabeled', () => {
      expect(parseSecretOwnership(undefined)).toEqual({ kind: 'unlabeled' })
      expect(parseSecretOwnership({})).toEqual({ kind: 'unlabeled' })
    })
    it('treats shared!=="true" as unlabeled (only the literal string grants share)', () => {
      expect(parseSecretOwnership({ [SHARED_LABEL_KEY]: 'yes' })).toEqual({ kind: 'unlabeled' })
    })
    it('fails closed on conflicting owner+shared labels → unlabeled', () => {
      expect(
        parseSecretOwnership({ [OWNER_RECIPE_LABEL_KEY]: 'recipe-a', [SHARED_LABEL_KEY]: 'true' })
      ).toEqual({ kind: 'unlabeled' })
    })
  })

  describe('isSecretAccessibleByRecipe', () => {
    it('grants a shared Secret to any recipe', () => {
      expect(isSecretAccessibleByRecipe({ [SHARED_LABEL_KEY]: 'true' }, 'recipe-a')).toBe(true)
    })
    it('grants an owned Secret only to its owner recipe', () => {
      expect(isSecretAccessibleByRecipe({ [OWNER_RECIPE_LABEL_KEY]: 'recipe-a' }, 'recipe-a')).toBe(
        true
      )
      expect(isSecretAccessibleByRecipe({ [OWNER_RECIPE_LABEL_KEY]: 'recipe-a' }, 'recipe-b')).toBe(
        false
      )
    })
    it('denies an unlabeled Secret', () => {
      expect(isSecretAccessibleByRecipe(undefined, 'recipe-a')).toBe(false)
      expect(isSecretAccessibleByRecipe({}, 'recipe-a')).toBe(false)
    })
    it('denies a conflicting owner+shared Secret (fail closed)', () => {
      expect(
        isSecretAccessibleByRecipe(
          { [OWNER_RECIPE_LABEL_KEY]: 'recipe-a', [SHARED_LABEL_KEY]: 'true' },
          'recipe-a'
        )
      ).toBe(false)
    })
  })
})
