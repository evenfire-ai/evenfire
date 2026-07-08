import { describe, expect, it } from 'vitest'
import { SecretReverseIndex } from './secretReverseIndex'

describe('SecretReverseIndex', () => {
  it('returns an empty array when no recipe references a secret', () => {
    const idx = new SecretReverseIndex()
    expect(idx.recipesFor('s1')).toEqual([])
  })

  it('records and returns recipes that reference a secret', () => {
    const idx = new SecretReverseIndex()
    idx.set('recipe-a', ['s1', 's2'])
    expect(idx.recipesFor('s1').sort()).toEqual(['recipe-a'])
    expect(idx.recipesFor('s2').sort()).toEqual(['recipe-a'])
    expect(idx.recipesFor('s3')).toEqual([])
  })

  it('aggregates multiple recipes on the same secret', () => {
    const idx = new SecretReverseIndex()
    idx.set('recipe-a', ['s1'])
    idx.set('recipe-b', ['s1'])
    expect(idx.recipesFor('s1').sort()).toEqual(['recipe-a', 'recipe-b'])
  })

  it('drops the recipe from secrets it no longer references on set()', () => {
    const idx = new SecretReverseIndex()
    idx.set('recipe-a', ['s1', 's2'])
    idx.set('recipe-a', ['s2', 's3'])
    expect(idx.recipesFor('s1')).toEqual([])
    expect(idx.recipesFor('s2')).toEqual(['recipe-a'])
    expect(idx.recipesFor('s3')).toEqual(['recipe-a'])
  })

  it('garbage-collects secret buckets when the last recipe leaves', () => {
    const idx = new SecretReverseIndex()
    idx.set('recipe-a', ['s1'])
    idx.set('recipe-b', ['s1'])
    expect(idx.secretCount()).toBe(1)
    idx.set('recipe-a', [])
    expect(idx.secretCount()).toBe(1)
    idx.set('recipe-b', [])
    expect(idx.secretCount()).toBe(0)
  })

  it('delete() removes the recipe from every secret bucket', () => {
    const idx = new SecretReverseIndex()
    idx.set('recipe-a', ['s1', 's2'])
    idx.set('recipe-b', ['s2'])
    idx.delete('recipe-a')
    expect(idx.recipesFor('s1')).toEqual([])
    expect(idx.recipesFor('s2')).toEqual(['recipe-b'])
  })

  it('delete() on an unknown recipe is a no-op', () => {
    const idx = new SecretReverseIndex()
    idx.set('recipe-a', ['s1'])
    expect(() => idx.delete('recipe-ghost')).not.toThrow()
    expect(idx.recipesFor('s1')).toEqual(['recipe-a'])
  })

  it('idempotent set() on identical input does not duplicate entries', () => {
    const idx = new SecretReverseIndex()
    idx.set('recipe-a', ['s1'])
    idx.set('recipe-a', ['s1'])
    expect(idx.recipesFor('s1')).toEqual(['recipe-a'])
  })
})
