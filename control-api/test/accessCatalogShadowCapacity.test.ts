import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCESS_EXECUTION_LIMIT_CLAMPS } from '../src/services/access/accessExecutionBudget.js'

const ORIGINAL_MODE = process.env.CONTROL_API_USER_ACCESS_CATALOG_MODE
const ORIGINAL_TEAM_GFS_ADMISSION =
  process.env.CONTROL_API_USER_ACCESS_TEAM_GFS_MEMBERSHIP_ADMISSION_LIMIT

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  if (ORIGINAL_MODE === undefined) {
    delete process.env.CONTROL_API_USER_ACCESS_CATALOG_MODE
  } else {
    process.env.CONTROL_API_USER_ACCESS_CATALOG_MODE = ORIGINAL_MODE
  }
  if (ORIGINAL_TEAM_GFS_ADMISSION === undefined) {
    delete process.env.CONTROL_API_USER_ACCESS_TEAM_GFS_MEMBERSHIP_ADMISSION_LIMIT
  } else {
    process.env.CONTROL_API_USER_ACCESS_TEAM_GFS_MEMBERSHIP_ADMISSION_LIMIT =
      ORIGINAL_TEAM_GFS_ADMISSION
  }
})

describe('aggregate access shadow scheduling capacity', () => {
  it('reserves bounded capacity before deferring comparison work', async () => {
    process.env.CONTROL_API_USER_ACCESS_CATALOG_MODE = 'shadow'
    process.env.CONTROL_API_USER_ACCESS_TEAM_GFS_MEMBERSHIP_ADMISSION_LIMIT = '4'
    vi.resetModules()
    const deferred: Array<() => void> = []
    vi.stubGlobal('setImmediate', (callback: () => void) => {
      deferred.push(callback)
      return {} as NodeJS.Immediate
    })
    const { scheduleAccessCatalogShadow } =
      await import('../src/services/access/accessCatalogShadow.js')
    const session = {
      contract: 'v1' as const,
      userId: '10000000-0000-4000-8000-000000000001',
      tokenHash: 'token-hash',
      issuedAt: 1_900_000_000,
      authGeneration: 1,
    }

    for (let index = 0; index < 1_000; index += 1) {
      scheduleAccessCatalogShadow({
        session,
        family: 'team',
        legacyLogicalIds: [],
        legacyComplete: true,
      })
    }

    expect(deferred).toHaveLength(ACCESS_EXECUTION_LIMIT_CLAMPS.producerConcurrency)
  })

  it('reserves all 109 shadow statements before starting comparison work', async () => {
    const [{ AccessExecutionBudget }, { compareAccessCatalogShadow }] = await Promise.all([
      import('../src/services/access/accessExecutionBudget.js'),
      import('../src/services/access/accessCatalogShadow.js'),
    ])
    const session = {
      contract: 'v1' as const,
      userId: '10000000-0000-4000-8000-000000000001',
      tokenHash: 'token-hash',
      issuedAt: 1_900_000_000,
      authGeneration: 1,
    }
    const tooSmall = AccessExecutionBudget.create('catalog', {
      limits: { databaseStatements: 108 },
    })
    const unusedBuild = vi.fn(async () => ({
      complete: true,
      items: [],
      nextCursor: null,
      partialErrors: [],
    }))
    try {
      await expect(
        compareAccessCatalogShadow(
          { session, family: 'gfs_resource', legacyLogicalIds: [], legacyComplete: true },
          { enabled: true, budget: tooSmall, buildCatalog: unusedBuild }
        )
      ).resolves.toBe('skipped_capacity')
      expect(unusedBuild).not.toHaveBeenCalled()
      expect(tooSmall.remaining('databaseStatements')).toBe(108)
    } finally {
      tooSmall.close()
    }

    const exact = AccessExecutionBudget.create('catalog', {
      limits: { databaseStatements: 109 },
    })
    const observedChildLimits: number[] = []
    try {
      await expect(
        compareAccessCatalogShadow(
          { session, family: 'gfs_resource', legacyLogicalIds: [], legacyComplete: true },
          {
            enabled: true,
            budget: exact,
            buildCatalog: vi.fn(async (_input, options) => {
              observedChildLimits.push(options.budget!.limits.databaseStatements)
              return { complete: true, items: [], nextCursor: null, partialErrors: [] }
            }),
          }
        )
      ).resolves.toBe('match')
      expect(observedChildLimits).toEqual([109])
      expect(exact.remaining('databaseStatements')).toBe(109)
    } finally {
      exact.close()
    }
  })
})
