import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const MODE = 'CONTROL_API_USER_ACCESS_CATALOG_MODE'
const ADMISSION = 'CONTROL_API_USER_ACCESS_TEAM_GFS_MEMBERSHIP_ADMISSION_LIMIT'
const originalMode = process.env[MODE]
const originalAdmission = process.env[ADMISSION]

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  restore(MODE, originalMode)
  restore(ADMISSION, originalAdmission)
  vi.resetModules()
})

describe('configured Team-GFS catalog admission', () => {
  it('allows rollout off without an admission input', async () => {
    delete process.env[MODE]
    delete process.env[ADMISSION]
    vi.resetModules()
    const { loadConfiguredUserAccessIntent } =
      await import('../src/services/access/userAccessPolicy.js')

    expect(loadConfiguredUserAccessIntent(process.env)).toMatchObject({
      catalogMode: 'off',
      teamGfsMembershipAdmissionLimit: null,
    })
  })

  it.each(['shadow', 'serve_and_shadow', 'serve'] as const)(
    'rejects missing Team-GFS admission before %s activation',
    async catalogMode => {
      const { loadConfiguredUserAccessIntent, UserAccessPolicyConfigurationError } =
        await import('../src/services/access/userAccessPolicy.js')

      expect(() =>
        loadConfiguredUserAccessIntent({ CONTROL_API_USER_ACCESS_CATALOG_MODE: catalogMode })
      ).toThrowError(
        new UserAccessPolicyConfigurationError(
          'control_api_user_access_team_gfs_membership_admission_limit_missing'
        )
      )
    }
  )

  it.each(['0', '-1', '1.5', 'not-a-number'])(
    'rejects invalid operator admission value %s',
    async value => {
      const { loadConfiguredUserAccessIntent, UserAccessPolicyConfigurationError } =
        await import('../src/services/access/userAccessPolicy.js')

      expect(() =>
        loadConfiguredUserAccessIntent({
          CONTROL_API_USER_ACCESS_CATALOG_MODE: 'shadow',
          CONTROL_API_USER_ACCESS_TEAM_GFS_MEMBERSHIP_ADMISSION_LIMIT: value,
        })
      ).toThrowError(
        new UserAccessPolicyConfigurationError(
          'control_api_user_access_team_gfs_membership_admission_limit_invalid'
        )
      )
    }
  )

  it('passes the exact operator value through the real route budget construction', async () => {
    process.env[MODE] = 'serve'
    process.env[ADMISSION] = '3'
    vi.resetModules()
    const { attachAccessExecutionBudget } =
      await import('../src/middleware/accessExecutionBudget.js')
    const req = Object.assign(new EventEmitter(), {
      method: 'GET',
      path: '/external/access/catalog',
    })
    const res = Object.assign(new EventEmitter(), { writableEnded: false })
    const next = vi.fn()

    attachAccessExecutionBudget(req as never, res as never, next)

    const budget = (
      req as { accessExecutionBudget?: { teamGfsMembershipAdmissionLimit: number | null } }
    ).accessExecutionBudget
    expect(next).toHaveBeenCalledOnce()
    expect(budget?.teamGfsMembershipAdmissionLimit).toBe(3)
    res.emit('finish')
  })

  it('passes the exact operator value into the production shadow comparison budget', async () => {
    process.env[MODE] = 'shadow'
    process.env[ADMISSION] = '2'
    vi.resetModules()
    const { compareAccessCatalogShadow } =
      await import('../src/services/access/accessCatalogShadow.js')
    const buildCatalog = vi.fn(async (_input, options) => {
      expect(options.budget?.teamGfsMembershipAdmissionLimit).toBe(2)
      return {
        contractVersion: '2' as const,
        authorizationRevision: 'revision',
        sourceStateRevision: 'source',
        complete: true,
        partialErrors: [],
        items: [],
        nextCursor: null,
      }
    })

    await expect(
      compareAccessCatalogShadow(
        {
          session: {
            contract: 'v1',
            userId: '10000000-0000-4000-8000-000000000001',
            tokenHash: 'token-hash',
            issuedAt: 1_900_000_000,
            authGeneration: 1,
          },
          family: 'gfs_resource',
          legacyLogicalIds: [],
          legacyComplete: true,
        },
        { enabled: true, buildCatalog }
      )
    ).resolves.toBe('match')
    expect(buildCatalog).toHaveBeenCalledOnce()
  })
})
