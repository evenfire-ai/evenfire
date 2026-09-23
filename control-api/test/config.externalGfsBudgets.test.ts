import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Regression guard for the actor-keyed external GFS budgets: one per read
 * class (resource, proxy-read, grants-read, shares-read) and one shared by the
 * three mutation classes (config.externalGfsOperationRlPerMin).
 *
 * The operation budget is derived from the largest Desktop upload: one part
 * per preferred part size up to the default product maximum, plus one create
 * and one complete call. The two upload constants below are hard-coded
 * mirrors of desktop-app/src/gfs/upload.ts, and each mirror is verified
 * against that file, so changing the Desktop part size without re-deriving
 * this budget fails HERE, in control-api CI.
 */

// Hard-coded mirrors of desktop-app/src/gfs/upload.ts, in MiB.
const UPLOAD_PRODUCT_MAX_MIB = 200
const UPLOAD_PREFERRED_PART_MIB = 8
// create + complete around the parts.
const UPLOAD_LIFECYCLE_CALLS = 2
const MAX_UPLOAD_MUTATIONS =
  Math.ceil(UPLOAD_PRODUCT_MAX_MIB / UPLOAD_PREFERRED_PART_MIB) + UPLOAD_LIFECYCLE_CALLS

// Every read class: its environment variable, config field, default and
// compiled ceiling.
const READ_CLASSES = [
  {
    env: 'CONTROL_API_EXTERNAL_GFS_RESOURCE_READ_RL_PER_MIN',
    field: 'externalGfsResourceReadRlPerMin',
    defaultPerMin: 480,
    ceiling: 960,
    hasMutationCounterpart: true,
  },
  {
    env: 'CONTROL_API_EXTERNAL_GFS_PROXY_READ_RL_PER_MIN',
    field: 'externalGfsProxyReadRlPerMin',
    defaultPerMin: 480,
    ceiling: 960,
    hasMutationCounterpart: false,
  },
  {
    env: 'CONTROL_API_EXTERNAL_GFS_GRANTS_READ_RL_PER_MIN',
    field: 'externalGfsGrantsReadRlPerMin',
    defaultPerMin: 120,
    ceiling: 480,
    hasMutationCounterpart: true,
  },
  {
    env: 'CONTROL_API_EXTERNAL_GFS_SHARES_READ_RL_PER_MIN',
    field: 'externalGfsSharesReadRlPerMin',
    defaultPerMin: 120,
    ceiling: 480,
    hasMutationCounterpart: true,
  },
] as const

const ENV_KEYS = [
  ...READ_CLASSES.map(readClass => readClass.env),
  'CONTROL_API_EXTERNAL_GFS_OPERATION_RL_PER_MIN',
  // Removed; deleted here so a host that still sets it cannot affect a case.
  'CONTROL_API_EXTERNAL_GFS_READ_RL_PER_MIN',
] as const

const DEFAULT_INVARIANT_INPUT = {
  resourceReadPerMin: 480,
  proxyReadPerMin: 480,
  grantsReadPerMin: 120,
  sharesReadPerMin: 120,
  operationPerMin: 90,
  ipPerMin: 1200,
}
const INVARIANT_FIELD = {
  CONTROL_API_EXTERNAL_GFS_RESOURCE_READ_RL_PER_MIN: 'resourceReadPerMin',
  CONTROL_API_EXTERNAL_GFS_PROXY_READ_RL_PER_MIN: 'proxyReadPerMin',
  CONTROL_API_EXTERNAL_GFS_GRANTS_READ_RL_PER_MIN: 'grantsReadPerMin',
  CONTROL_API_EXTERNAL_GFS_SHARES_READ_RL_PER_MIN: 'sharesReadPerMin',
} as const

async function loadConfigModuleWith(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  const originalValues = new Map<string, string | undefined>()
  for (const key of ENV_KEYS) {
    originalValues.set(key, process.env[key])
    // Deleted explicitly: a default test that merely omits the variable would
    // pass for the wrong reason on any host where it is set.
    delete process.env[key]
  }
  Object.assign(process.env, overrides)
  vi.resetModules()
  try {
    return await import('../src/config.js')
  } finally {
    for (const key of ENV_KEYS) {
      const value = originalValues.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Fail-loud single-match extraction — a miss means the source moved. */
function extractOne(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern)
  if (!match || match[1] === undefined) {
    throw new Error(`Could not extract ${label} with ${pattern} — re-derive the mirrors`)
  }
  return match[1]
}

describe('external GFS actor budgets', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('derives the operation budget from the live Desktop upload constants', async () => {
    const upload = readFileSync(
      new URL('../../desktop-app/src/gfs/upload.ts', import.meta.url),
      'utf-8'
    )
    const productMaxMib = extractOne(
      upload,
      /GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024\b/,
      'Desktop upload product maximum'
    )
    const preferredPartMib = extractOne(
      upload,
      /GFS_UPLOAD_V2_PREFERRED_PART_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024\b/,
      'Desktop upload preferred part size'
    )
    expect(Number(productMaxMib)).toBe(UPLOAD_PRODUCT_MAX_MIB)
    expect(Number(preferredPartMib)).toBe(UPLOAD_PREFERRED_PART_MIB)
    expect(MAX_UPLOAD_MUTATIONS).toBe(27)

    // 27 is a floor: larger parts, retried 429s and reconciliation add more.
    const { config } = await loadConfigModuleWith({})
    expect(config.externalGfsOperationRlPerMin).toBeGreaterThanOrEqual(MAX_UPLOAD_MUTATIONS)
  })

  it('L12: defaults to 480/480/120/120 reads and 90 operations per minute', async () => {
    const { config } = await loadConfigModuleWith({})
    expect(config.externalGfsResourceReadRlPerMin).toBe(480)
    expect(config.externalGfsProxyReadRlPerMin).toBe(480)
    expect(config.externalGfsGrantsReadRlPerMin).toBe(120)
    expect(config.externalGfsSharesReadRlPerMin).toBe(120)
    expect(config.externalGfsOperationRlPerMin).toBe(90)
  })

  it('L12: the four read classes sum to the per-IP all-class bucket', async () => {
    // Documented, not enforced at boot: one source IP is capped at the per-IP
    // bucket whatever the class mix, and with one shared read budget the
    // nominal sum was 1920.
    const { config } = await loadConfigModuleWith({})
    const readSum =
      config.externalGfsResourceReadRlPerMin +
      config.externalGfsProxyReadRlPerMin +
      config.externalGfsGrantsReadRlPerMin +
      config.externalGfsSharesReadRlPerMin
    expect(readSum).toBe(1200)
    expect(readSum).toBe(config.externalGfsIpRlPerMin)
  })

  it('ignores the removed shared read variable', async () => {
    const { config } = await loadConfigModuleWith({
      CONTROL_API_EXTERNAL_GFS_READ_RL_PER_MIN: '960',
    })
    expect(config.externalGfsResourceReadRlPerMin).toBe(480)
    expect(config.externalGfsProxyReadRlPerMin).toBe(480)
    expect(config.externalGfsGrantsReadRlPerMin).toBe(120)
    expect(config.externalGfsSharesReadRlPerMin).toBe(120)
  })

  it('accepts every class at its ceiling', async () => {
    const { config } = await loadConfigModuleWith({
      ...Object.fromEntries(
        READ_CLASSES.map(readClass => [readClass.env, String(readClass.ceiling)])
      ),
      CONTROL_API_EXTERNAL_GFS_OPERATION_RL_PER_MIN: '180',
    })
    for (const readClass of READ_CLASSES) {
      expect(config[readClass.field]).toBe(readClass.ceiling)
    }
    expect(config.externalGfsOperationRlPerMin).toBe(180)
  })

  it.each([
    ...READ_CLASSES.map(readClass => [readClass.env, readClass.ceiling] as const),
    ['CONTROL_API_EXTERNAL_GFS_OPERATION_RL_PER_MIN', 180] as const,
  ])('refuses to boot with %s above its ceiling %i', async (env, ceiling) => {
    await expect(loadConfigModuleWith({ [env]: String(ceiling + 1) })).rejects.toThrow(
      `${env} must be an integer between 1 and ${ceiling}`
    )
  })

  it.each(READ_CLASSES.filter(readClass => readClass.hasMutationCounterpart))(
    'refuses to boot when the operation budget exceeds $env',
    async readClass => {
      await expect(
        loadConfigModuleWith({
          // 110 exceeds only the class under test: every other read budget
          // keeps its default of 120 or more.
          [readClass.env]: '100',
          CONTROL_API_EXTERNAL_GFS_OPERATION_RL_PER_MIN: '110',
        })
      ).rejects.toThrow(
        'CONTROL_API_EXTERNAL_GFS_OPERATION_RL_PER_MIN (110) must not exceed ' +
          `${readClass.env} (100)`
      )
    }
  )

  it('boots with a proxy-read budget below the operation budget: proxy has no mutations', async () => {
    const { config } = await loadConfigModuleWith({
      CONTROL_API_EXTERNAL_GFS_PROXY_READ_RL_PER_MIN: '10',
    })
    expect(config.externalGfsProxyReadRlPerMin).toBe(10)
    expect(config.externalGfsOperationRlPerMin).toBe(90)
  })

  it.each(READ_CLASSES)(
    'L9: $env at its ceiling stays within the per-IP bucket',
    async readClass => {
      // The per-IP half of assertExternalGfsBudgetInvariants cannot fire from
      // the environment today: every read ceiling is below the compiled per-IP
      // budget. This pins that relation, so lowering the per-IP budget or
      // raising a read ceiling has to be a decision, not a boot failure found
      // in a deploy.
      const { config } = await loadConfigModuleWith({
        [readClass.env]: String(readClass.ceiling),
      })
      expect(config[readClass.field]).toBe(readClass.ceiling)
      expect(config[readClass.field]).toBeLessThanOrEqual(config.externalGfsIpRlPerMin)
    }
  )

  it.each(READ_CLASSES)(
    'refuses $env above the per-IP budget and accepts it at the boundary',
    async readClass => {
      const { assertExternalGfsBudgetInvariants } = await loadConfigModuleWith({})
      const field = INVARIANT_FIELD[readClass.env]
      expect(() =>
        assertExternalGfsBudgetInvariants({ ...DEFAULT_INVARIANT_INPUT, [field]: 1300 })
      ).toThrow(
        `${readClass.env} (1300) must not exceed ` +
          'the per-IP external GFS budget externalGfsIpRlPerMin (1200)'
      )
      // Liveness witness for the check being `<=`, not `<`: equal values pass.
      expect(() =>
        assertExternalGfsBudgetInvariants({ ...DEFAULT_INVARIANT_INPUT, [field]: 1200 })
      ).not.toThrow()
    }
  )
})
