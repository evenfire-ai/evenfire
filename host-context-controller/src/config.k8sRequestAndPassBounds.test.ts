import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

const BOUND_NAMES = [
  'HCC_HOST_K8S_REQUEST_TIMEOUT_MS',
  'HCC_K8S_REQUEST_TIMEOUT_MS',
  'HCC_NETPOL_PASS_HARD_LIMIT_MS',
]

async function loadConfigWith(values: Record<string, string | undefined>) {
  vi.resetModules()
  process.env = { ...originalEnv }
  for (const name of BOUND_NAMES) delete process.env[name]
  for (const [name, raw] of Object.entries(values)) {
    if (raw !== undefined) process.env[name] = raw
  }
  return import('./config')
}

async function loadConfig(name: string, raw: string | undefined) {
  return loadConfigWith({ [name]: raw })
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('HCC_HOST_K8S_REQUEST_TIMEOUT_MS', () => {
  it('defaults to 30000 when unset', async () => {
    const { config } = await loadConfig('HCC_HOST_K8S_REQUEST_TIMEOUT_MS', undefined)
    expect(config.hostK8sRequestTimeoutMs).toBe(30_000)
  })

  it('accepts 2147483646 with the hard limit at the timer maximum', async () => {
    const { config } = await loadConfigWith({
      HCC_HOST_K8S_REQUEST_TIMEOUT_MS: '2147483646',
      HCC_NETPOL_PASS_HARD_LIMIT_MS: '2147483647',
    })
    expect(config.hostK8sRequestTimeoutMs).toBe(2_147_483_646)
  })

  it('defaults to 30000 when set to an empty string', async () => {
    const { config } = await loadConfig('HCC_HOST_K8S_REQUEST_TIMEOUT_MS', '')
    expect(config.hostK8sRequestTimeoutMs).toBe(30_000)
  })

  // Node clamps a larger timer delay to 1 ms, so every Host request would
  // time out at once. Number() would read every other spelling below.
  it.each([
    '2147483648',
    '0',
    ' ',
    '+30000',
    ' 30000',
    '30000 ',
    '30000\n',
    '030000',
    '3e4',
    '0x7530',
    '0b111010100110000',
    '0o72460',
    '30000.0',
  ])("fails configuration validation for '%s'", async raw => {
    await expect(loadConfig('HCC_HOST_K8S_REQUEST_TIMEOUT_MS', raw)).rejects.toThrow(
      'HCC_HOST_K8S_REQUEST_TIMEOUT_MS must be a positive integer'
    )
  })
})

describe('HCC_K8S_REQUEST_TIMEOUT_MS', () => {
  it('defaults to 30000 when unset', async () => {
    const { config } = await loadConfig('HCC_K8S_REQUEST_TIMEOUT_MS', undefined)
    expect(config.k8sRequestTimeoutMs).toBe(30_000)
  })

  it.each([
    ['1', 1],
    ['45000', 45_000],
  ])('accepts %s', async (raw, expected) => {
    const { config } = await loadConfig('HCC_K8S_REQUEST_TIMEOUT_MS', raw)
    expect(config.k8sRequestTimeoutMs).toBe(expected)
  })

  it('accepts 2147483646 with the hard limit at the timer maximum', async () => {
    const { config } = await loadConfigWith({
      HCC_K8S_REQUEST_TIMEOUT_MS: '2147483646',
      HCC_NETPOL_PASS_HARD_LIMIT_MS: '2147483647',
    })
    expect(config.k8sRequestTimeoutMs).toBe(2_147_483_646)
  })

  it('defaults to 30000 when set to an empty string', async () => {
    const { config } = await loadConfig('HCC_K8S_REQUEST_TIMEOUT_MS', '')
    expect(config.k8sRequestTimeoutMs).toBe(30_000)
  })

  it.each([
    '0',
    '-1',
    '1.5',
    '30s',
    'NaN',
    '2147483648',
    ' ',
    '+30000',
    ' 30000',
    '30000 ',
    '30000\n',
    '030000',
    '3e4',
    '0x7530',
    '0b111010100110000',
    '0o72460',
    '30000.0',
  ])("fails configuration validation for '%s'", async raw => {
    await expect(loadConfig('HCC_K8S_REQUEST_TIMEOUT_MS', raw)).rejects.toThrow(
      'HCC_K8S_REQUEST_TIMEOUT_MS must be a positive integer'
    )
  })
})

describe('HCC_NETPOL_PASS_HARD_LIMIT_MS', () => {
  it('defaults to 30 minutes when unset', async () => {
    const { config } = await loadConfig('HCC_NETPOL_PASS_HARD_LIMIT_MS', undefined)
    expect(config.netPolPassHardLimitMs).toBe(1_800_000)
  })

  it.each([
    ['300001', 300_001],
    ['3600000', 3_600_000],
    ['2147483647', 2_147_483_647],
  ])('accepts %s', async (raw, expected) => {
    const { config } = await loadConfig('HCC_NETPOL_PASS_HARD_LIMIT_MS', raw)
    expect(config.netPolPassHardLimitMs).toBe(expected)
  })

  it('defaults to 30 minutes when set to an empty string', async () => {
    const { config } = await loadConfig('HCC_NETPOL_PASS_HARD_LIMIT_MS', '')
    expect(config.netPolPassHardLimitMs).toBe(1_800_000)
  })

  it.each([
    '0',
    '-1',
    '300000',
    '1.5',
    '30m',
    'NaN',
    '2147483648',
    ' ',
    '+1800000',
    ' 1800000',
    '1800000 ',
    '1800000\n',
    '01800000',
    '18e5',
    '0x1B7740',
    '1800000.0',
  ])("fails configuration validation for '%s'", async raw => {
    await expect(loadConfig('HCC_NETPOL_PASS_HARD_LIMIT_MS', raw)).rejects.toThrow(
      'HCC_NETPOL_PASS_HARD_LIMIT_MS must be an integer number of milliseconds above the 300000ms overrun warning'
    )
  })
})

describe('request timeouts below the pass hard limit', () => {
  const below = 'must be below HCC_NETPOL_PASS_HARD_LIMIT_MS'

  it.each([
    ['HCC_K8S_REQUEST_TIMEOUT_MS', 'k8sRequestTimeoutMs'],
    ['HCC_HOST_K8S_REQUEST_TIMEOUT_MS', 'hostK8sRequestTimeoutMs'],
  ] as const)('%s: 1799999 starts with the default hard limit', async (name, key) => {
    const { config } = await loadConfigWith({ [name]: '1799999' })
    expect(config[key]).toBe(1_799_999)
    expect(config.netPolPassHardLimitMs).toBe(1_800_000)
  })

  it.each(['HCC_K8S_REQUEST_TIMEOUT_MS', 'HCC_HOST_K8S_REQUEST_TIMEOUT_MS'])(
    '%s: 1800000 and 2147483647 refuse with the default hard limit',
    async name => {
      for (const raw of ['1800000', '2147483647']) {
        await expect(loadConfigWith({ [name]: raw })).rejects.toThrow(
          `${name} (${raw}ms) ${below} (1800000ms)`
        )
      }
    }
  )

  it.each(['HCC_K8S_REQUEST_TIMEOUT_MS', 'HCC_HOST_K8S_REQUEST_TIMEOUT_MS'])(
    '%s: 400000 refuses with the hard limit at 400000 and starts at 400001',
    async name => {
      await expect(
        loadConfigWith({ [name]: '400000', HCC_NETPOL_PASS_HARD_LIMIT_MS: '400000' })
      ).rejects.toThrow(`${name} (400000ms) ${below} (400000ms)`)
      const { config } = await loadConfigWith({
        [name]: '400000',
        HCC_NETPOL_PASS_HARD_LIMIT_MS: '400001',
      })
      expect(config.netPolPassHardLimitMs).toBe(400_001)
    }
  )

  it('starts with the Host timeout at 30000 and the hard limit at 300001', async () => {
    const { config } = await loadConfigWith({
      HCC_HOST_K8S_REQUEST_TIMEOUT_MS: '30000',
      HCC_NETPOL_PASS_HARD_LIMIT_MS: '300001',
    })
    expect(config.hostK8sRequestTimeoutMs).toBe(30_000)
  })

  it('an empty hard limit means the default, which a 1800000 timeout does not stay below', async () => {
    await expect(
      loadConfigWith({ HCC_K8S_REQUEST_TIMEOUT_MS: '1800000', HCC_NETPOL_PASS_HARD_LIMIT_MS: '' })
    ).rejects.toThrow(`HCC_K8S_REQUEST_TIMEOUT_MS (1800000ms) ${below} (1800000ms)`)
  })

  it('empty timeouts mean 30000, which stays below a 300001 hard limit', async () => {
    const { config } = await loadConfigWith({
      HCC_K8S_REQUEST_TIMEOUT_MS: '',
      HCC_HOST_K8S_REQUEST_TIMEOUT_MS: '',
      HCC_NETPOL_PASS_HARD_LIMIT_MS: '300001',
    })
    expect(config.k8sRequestTimeoutMs).toBe(30_000)
    expect(config.hostK8sRequestTimeoutMs).toBe(30_000)
  })

  it('reports a misspelt timeout before the comparison', async () => {
    await expect(
      loadConfigWith({
        HCC_K8S_REQUEST_TIMEOUT_MS: '18e5',
        HCC_NETPOL_PASS_HARD_LIMIT_MS: '400000',
      })
    ).rejects.toThrow('HCC_K8S_REQUEST_TIMEOUT_MS must be a positive integer')
  })
})

describe('assertRequestTimeoutsBelowPassHardLimit', () => {
  it('passes a timeout below the limit and throws at or above it, naming the variable', async () => {
    const { assertRequestTimeoutsBelowPassHardLimit } = await loadConfigWith({})
    expect(() =>
      assertRequestTimeoutsBelowPassHardLimit([{ name: 'A', valueMs: 30_000 }], 1_800_000)
    ).not.toThrow()
    for (const valueMs of [1_800_000, 1_800_001]) {
      expect(() =>
        assertRequestTimeoutsBelowPassHardLimit(
          [
            { name: 'A', valueMs: 30_000 },
            { name: 'B', valueMs },
          ],
          1_800_000
        )
      ).toThrow(`B (${valueMs}ms) must be below HCC_NETPOL_PASS_HARD_LIMIT_MS (1800000ms)`)
    }
  })
})
