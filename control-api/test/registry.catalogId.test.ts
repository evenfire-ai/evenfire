import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  catalogAnnotations,
  generateRegistryName,
  getCatalogId,
  getCatalogVersion,
} from '../src/routes/admin/registry.js'

// Checked-in contract shared with evenfire-registry: the catalog name, the
// version, and the annotation key that carries the catalog id. The matching
// name-derivation assertion is mirrored there so both repos agree on the
// round-trip key without a runtime dependency.
const FIXTURE = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'registry-name-contract.json'),
    'utf8'
  )
) as { catalogName: string; version: string; catalogIdAnnotationKey: string }

describe('getCatalogId / getCatalogVersion (annotation-first, label fallback)', () => {
  it('reads the catalog id from an annotation', () => {
    expect(getCatalogId({ annotations: { 'clerum.io/catalog-id': '@newtenantwf/brain' } })).toBe(
      '@newtenantwf/brain'
    )
  })

  // Ports the intent of commit ad8bab59b: resources installed before catalog-id
  // moved to annotations carry it as a LABEL and must still read as installed.
  it('falls back to the legacy label when no annotation is present', () => {
    expect(getCatalogId({ labels: { 'clerum.io/catalog-id': '@newtenantwf/brain' } })).toBe(
      '@newtenantwf/brain'
    )
    expect(getCatalogVersion({ labels: { 'clerum.io/catalog-version': '0.1.1' } })).toBe('0.1.1')
  })

  it('prefers the annotation over a stale label', () => {
    expect(
      getCatalogId({
        annotations: { 'clerum.io/catalog-id': '@a/b' },
        labels: { 'clerum.io/catalog-id': '@stale/x' },
      })
    ).toBe('@a/b')
    expect(
      getCatalogVersion({
        annotations: { 'clerum.io/catalog-version': '2.0.0' },
        labels: { 'clerum.io/catalog-version': '1.0.0' },
      })
    ).toBe('2.0.0')
  })

  it('is undefined-safe for missing metadata and missing keys', () => {
    expect(getCatalogId(undefined)).toBeUndefined()
    expect(getCatalogVersion(undefined)).toBeUndefined()
    expect(getCatalogId({})).toBeUndefined()
    expect(getCatalogVersion({ labels: {}, annotations: {} })).toBeUndefined()
  })

  it('catalogAnnotations stamps exactly the catalog-id / catalog-version pair', () => {
    expect(catalogAnnotations('@newtenantwf/brain', '0.1.1')).toEqual({
      'clerum.io/catalog-id': '@newtenantwf/brain',
      'clerum.io/catalog-version': '0.1.1',
    })
  })

  // Stamp → read round-trip: what catalogAnnotations writes is what the getters
  // read back, including org-scoped names that are illegal as label values.
  it('round-trips a stamped annotation through the getters', () => {
    const meta = { annotations: catalogAnnotations('@newtenantwf/brain', '0.1.1') }
    expect(getCatalogId(meta)).toBe('@newtenantwf/brain')
    expect(getCatalogVersion(meta)).toBe('0.1.1')
  })
})

describe('generateRegistryName cross-repo name-derivation contract', () => {
  const RFC1123 = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

  it('derives an RFC1123, ≤63-char, mcp-prefixed, deterministic name from the fixture', () => {
    const name = generateRegistryName(FIXTURE.catalogName, FIXTURE.version)
    expect(name).toMatch(RFC1123)
    expect(name.length).toBeLessThanOrEqual(63)
    expect(name.startsWith('mcp-')).toBe(true)
    // Deterministic: same inputs → same name.
    expect(generateRegistryName(FIXTURE.catalogName, FIXTURE.version)).toBe(name)
  })

  it('binds the catalog-id annotation key the registry stamps under', () => {
    expect(FIXTURE.catalogIdAnnotationKey).toBe('clerum.io/catalog-id')
    expect(
      catalogAnnotations(FIXTURE.catalogName, FIXTURE.version)[FIXTURE.catalogIdAnnotationKey]
    ).toBe(FIXTURE.catalogName)
  })
})
