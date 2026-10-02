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
})
