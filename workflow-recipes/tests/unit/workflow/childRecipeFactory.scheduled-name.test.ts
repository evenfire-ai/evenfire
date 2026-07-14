import { describe, expect, it } from 'vitest'
import { type ParentRecipe, buildChildRecipe } from '../../../src/workflow/childRecipeFactory.js'

/**
 * Spec: docs/architecture/workflow-recipe-naming.md §1 (63-byte ceiling) and
 * §2.4 (parent-stem truncation rule).
 *
 * The scheduled / on-demand child name produced by buildChildRecipe flows into
 * K8s label values and DNS-1123 labels (Service / Deployment metadata.name)
 * downstream, all capped at 63 bytes. A catalog-installed parent named by
 * control-api `generateRegistryName` (e.g.
 * `recipe-<tenant>-<plugin>-vX-Y-Z-<hash8>`, ~56 chars) plus the
 * `-YYYYMMDD-HHMMSS-NNNN` suffix (~21 chars) overflows 63 → invalid label →
 * apiserver 422 at reconcile. The name must therefore be length-bounded.
 *
 * Crucially, `generateRegistryName` carries a parent's uniqueness in a TRAILING
 * 8-hex hash, so naive prefix truncation would drop the disambiguator and make
 * two distinct parents collide. When the stem is shortened we re-attach a stable
 * hash of the FULL parent name (mirroring §2.5's `hash8` convention).
 */
const DNS_1123_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

function makeParent(name: string): ParentRecipe {
  return {
    metadata: { name, namespace: 'sandbox-recipes', uid: 'u' },
    spec: {},
  }
}

const NOW = new Date('2026-06-17T00:00:00Z')

describe('buildChildRecipe scheduled/on-demand name bounding', () => {
  it('bounds a long generateRegistryName-style parent to a valid ≤63-byte DNS label', () => {
    // ~56-char catalog parent: recipe-<tenant>-<plugin>-vX-Y-Z-<hash8>
    const parent = makeParent('recipe-newtenantwf-evenfire-brain-plugin-v0-1-1-3092f68d')
    const child = buildChildRecipe(parent, 0, NOW, { triggerKind: 'schedule' }) as any
    const name: string = child.metadata.name

    expect(name.length).toBeLessThanOrEqual(63)
    expect(name).toMatch(DNS_1123_LABEL)
    expect(name).not.toContain('--')
  })

  it('leaves a short parent name unchanged (no regression)', () => {
    const parent = makeParent('brain')
    const child = buildChildRecipe(parent, 0, NOW, { triggerKind: 'schedule' }) as any
    // 5 + len('-20260617-000000-0000') = 26 chars, comfortably under 63 → untouched.
    expect(child.metadata.name).toBe('brain-20260617-000000-0000')
    expect(child.metadata.name).toMatch(/^brain-\d{8}-\d{6}-\d{4}$/)
  })

  it('keeps two parents that differ only in the trailing 8-hex hash distinct', () => {
    // Identical for the first 42 chars, differing only in the trailing hash —
    // exactly the generateRegistryName collision case naive truncation breaks.
    const prefix = 'recipe-acme-very-long-plugin-name-here-v1-' // 42 chars
    expect(prefix.length).toBe(42)
    const a = makeParent(prefix + 'aaaaaaaa')
    const b = makeParent(prefix + 'bbbbbbbb')

    const nameA: string = (buildChildRecipe(a, 0, NOW, { triggerKind: 'schedule' }) as any).metadata
      .name
    const nameB: string = (buildChildRecipe(b, 0, NOW, { triggerKind: 'schedule' }) as any).metadata
      .name

    expect(nameA).not.toBe(nameB)
    expect(nameA.length).toBeLessThanOrEqual(63)
    expect(nameB.length).toBeLessThanOrEqual(63)
    expect(nameA).toMatch(DNS_1123_LABEL)
    expect(nameB).toMatch(DNS_1123_LABEL)
  })

  it('is deterministic: same inputs produce the same name', () => {
    const parent = makeParent('recipe-newtenantwf-evenfire-brain-plugin-v0-1-1-3092f68d')
    const first: string = (buildChildRecipe(parent, 0, NOW, { triggerKind: 'schedule' }) as any)
      .metadata.name
    const second: string = (buildChildRecipe(parent, 0, NOW, { triggerKind: 'schedule' }) as any)
      .metadata.name
    expect(first).toBe(second)
  })

  it('bounds a long parent paired with a long nameSuffix to a valid ≤63-byte label', () => {
    // The exact code-review failing input: an 87-char parent plus a 54-byte
    // suffix (`-<timestamp>-<index>-<32-char nameSuffix>`) used to overflow to
    // 64 bytes because the ≥1-char stem floor + `-<hash8>` was appended on top
    // of an already-near-full suffix.
    const parent = makeParent('recipe-' + 'a'.repeat(80))
    const child = buildChildRecipe(parent, 0, NOW, {
      triggerKind: 'schedule',
      nameSuffix: 'x'.repeat(32),
    }) as any
    const name: string = child.metadata.name

    expect(name.length).toBeLessThanOrEqual(63)
    expect(name).toMatch(DNS_1123_LABEL)
  })

  it('bounds an extreme nameSuffix (200 chars) to a valid ≤63-byte label', () => {
    const parent = makeParent('recipe-' + 'a'.repeat(80))
    const child = buildChildRecipe(parent, 0, NOW, {
      triggerKind: 'schedule',
      nameSuffix: 'y'.repeat(200),
    }) as any
    const name: string = child.metadata.name

    expect(name.length).toBeLessThanOrEqual(63)
    expect(name).toMatch(DNS_1123_LABEL)
  })

  it('keeps same-parent runs disambiguated even when the nameSuffix is bounded', () => {
    // Same long parent + long nameSuffix, but different executionIndex: the
    // fixed timestamp-index portion must survive so the two runs stay distinct.
    const parent = makeParent('recipe-' + 'a'.repeat(80))
    const opts = { triggerKind: 'schedule' as const, nameSuffix: 'z'.repeat(200) }
    const name0: string = (buildChildRecipe(parent, 0, NOW, opts) as any).metadata.name
    const name1: string = (buildChildRecipe(parent, 1, NOW, opts) as any).metadata.name
    expect(name0).not.toBe(name1)
    expect(name0.length).toBeLessThanOrEqual(63)
    expect(name1.length).toBeLessThanOrEqual(63)
    expect(name0).toMatch(DNS_1123_LABEL)
    expect(name1).toMatch(DNS_1123_LABEL)
  })

  it('routes an empty parent through stem sanitation (no leading hyphen)', () => {
    // Defensive: a real CRD name can't be empty, but the short-parent
    // pass-through branch must still share truncateStem's empty→"workflow"
    // sanitation rather than emitting a leading `-`.
    const parent = makeParent('')
    const name: string = (buildChildRecipe(parent, 0, NOW, { triggerKind: 'schedule' }) as any)
      .metadata.name
    expect(name.startsWith('-')).toBe(false)
    expect(name).toBe('workflow-20260617-000000-0000')
    expect(name).toMatch(DNS_1123_LABEL)
  })
})
