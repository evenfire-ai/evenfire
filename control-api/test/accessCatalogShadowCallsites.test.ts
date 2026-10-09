import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { CATALOG_FAMILIES, type CatalogFamily } from '../src/services/access/catalogContracts.js'

const SOURCES = [
  'src/routes/external/users.ts',
  'src/routes/external/workflows/read.routes.ts',
  'src/routes/external/workflows/runs.routes.ts',
  'src/routes/external/notifications.routes.ts',
  'src/routes/external/gfs.ts',
  'src/routes/external/sharedFilesystems.ts',
] as const

describe('aggregate shadow production call sites', () => {
  it('maps every frozen PR 1 family from an actual legacy discovery root', () => {
    const source = SOURCES.map(path => readFileSync(path, 'utf8')).join('\n')
    const observed = new Set<CatalogFamily>()
    for (const family of CATALOG_FAMILIES) {
      if (source.includes(`family: '${family}'`)) observed.add(family)
    }
    expect([...observed]).toEqual(CATALOG_FAMILIES)
  })

  it('keeps shadow scheduling out of authorization and response expressions', () => {
    for (const path of SOURCES) {
      const source = readFileSync(path, 'utf8')
      expect(source).not.toMatch(/await\s+scheduleAccessCatalogShadow/u)
      expect(source).not.toMatch(/res\.[a-z]+\([^)]*scheduleAccessCatalogShadow/u)
    }
  })
})
