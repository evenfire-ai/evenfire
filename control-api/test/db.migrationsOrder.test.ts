import { describe, expect, it, vi } from 'vitest'

// Mock pg exactly like the other db.*.test.ts specs so importing ../src/db.js
// does not spin up a real Pool as a module side effect.
vi.mock('pg', () => ({
  Pool: vi.fn(function MockPool() {
    return {
      connect: vi.fn(),
      query: vi.fn(),
    }
  }),
}))

describe('CONTROL_API_MIGRATIONS ordering invariant', () => {
  it('is strictly increasing by version-string across the whole array', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(m => m.version)

    // Migrations are applied in ARRAY ORDER and tracked by full version-string
    // in schema_migrations. Comparing lexicographically (a < b) mirrors that
    // apply order, so the array must be strictly increasing to stay predictable
    // after any future renumber/merge.
    const offenders: string[] = []
    for (let i = 1; i < versions.length; i += 1) {
      const prev = versions[i - 1]!
      const curr = versions[i]!
      if (!(prev < curr)) {
        offenders.push(`index ${i - 1}->${i}: '${prev}' !< '${curr}'`)
      }
    }

    expect(offenders, `non-monotonic version pair(s):\n${offenders.join('\n')}`).toEqual([])
  })

  it('has no duplicate version-strings', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const versions = CONTROL_API_MIGRATIONS.map(m => m.version)

    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const v of versions) {
      if (seen.has(v)) {
        duplicates.push(v)
      }
      seen.add(v)
    }

    expect(duplicates, `duplicate version-string(s):\n${duplicates.join('\n')}`).toEqual([])
  })

  it('keeps legacy aliases unique and distinct from current versions', async () => {
    const { CONTROL_API_MIGRATIONS } = await import('../src/db.js')
    const current = new Set(CONTROL_API_MIGRATIONS.map(migration => migration.version))
    const aliases = CONTROL_API_MIGRATIONS.flatMap(migration => migration.legacyVersions ?? [])
    const duplicates = aliases.filter((version, index) => aliases.indexOf(version) !== index)
    const currentCollisions = aliases.filter(version => current.has(version))

    expect(duplicates).toEqual([])
    expect(currentCollisions).toEqual([])
  })
})
