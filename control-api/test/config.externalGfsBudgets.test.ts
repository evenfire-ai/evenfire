import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Regression guard for the two actor-keyed external GFS budgets
 * (config.externalGfsReadRlPerMin, config.externalGfsOperationRlPerMin).
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

const ENV_KEYS = [
  'CONTROL_API_EXTERNAL_GFS_READ_RL_PER_MIN',
  'CONTROL_API_EXTERNAL_GFS_OPERATION_RL_PER_MIN',
] as const

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

  it('defaults to 480 reads and 90 operations per minute', async () => {
    const { config } = await loadConfigModuleWith({})
    expect(config.externalGfsReadRlPerMin).toBe(480)
    expect(config.externalGfsOperationRlPerMin).toBe(90)
  })

  it('accepts an environment override within the ceiling', async () => {
    const { config } = await loadConfigModuleWith({
      CONTROL_API_EXTERNAL_GFS_READ_RL_PER_MIN: '960',
      CONTROL_API_EXTERNAL_GFS_OPERATION_RL_PER_MIN: '180',
    })
    expect(config.externalGfsReadRlPerMin).toBe(960)
    expect(config.externalGfsOperationRlPerMin).toBe(180)
  })

  it('refuses to boot above either compiled ceiling', async () => {
    await expect(
      loadConfigModuleWith({ CONTROL_API_EXTERNAL_GFS_READ_RL_PER_MIN: '961' })
    ).rejects.toThrow(
      'CONTROL_API_EXTERNAL_GFS_READ_RL_PER_MIN must be an integer between 1 and 960'
    )
    await expect(
      loadConfigModuleWith({ CONTROL_API_EXTERNAL_GFS_OPERATION_RL_PER_MIN: '181' })
    ).rejects.toThrow(
      'CONTROL_API_EXTERNAL_GFS_OPERATION_RL_PER_MIN must be an integer between 1 and 180'
    )
  })

  it('refuses to boot when the operation budget exceeds the read budget', async () => {
    await expect(
      loadConfigModuleWith({
        CONTROL_API_EXTERNAL_GFS_READ_RL_PER_MIN: '100',
        CONTROL_API_EXTERNAL_GFS_OPERATION_RL_PER_MIN: '180',
      })
    ).rejects.toThrow(
      'CONTROL_API_EXTERNAL_GFS_OPERATION_RL_PER_MIN (180) must not exceed ' +
        'CONTROL_API_EXTERNAL_GFS_READ_RL_PER_MIN (100)'
    )
  })

  it('refuses a read budget above the per-IP budget and accepts it at the boundary', async () => {
    const { assertExternalGfsBudgetInvariants } = await loadConfigModuleWith({})
    expect(() =>
      assertExternalGfsBudgetInvariants({ readPerMin: 1300, operationPerMin: 90, ipPerMin: 1200 })
    ).toThrow(
      'CONTROL_API_EXTERNAL_GFS_READ_RL_PER_MIN (1300) must not exceed ' +
        'the per-IP external GFS budget externalGfsIpRlPerMin (1200)'
    )
    // Liveness witness for the check being `<=`, not `<`: equal values pass.
    expect(() =>
      assertExternalGfsBudgetInvariants({ readPerMin: 1200, operationPerMin: 90, ipPerMin: 1200 })
    ).not.toThrow()
  })
})
