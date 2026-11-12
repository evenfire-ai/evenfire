import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MAX_REQUEST_HOLD_MS,
  MAX_TIMER_DELAY_MS,
  parseArtifactDownloadMaxBytes,
  parsePositiveInt,
  parsePositiveIntMs,
  parseSandboxUiAllowedPorts,
  parseWakeMaxHoldMs,
} from '../config.js'

describe('parseSandboxUiAllowedPorts', () => {
  it('accepts a single port', () => {
    const set = parseSandboxUiAllowedPorts('8080')
    expect(set.has(8080)).toBe(true)
    expect(set.size).toBe(1)
  })

  it('accepts a comma-separated list', () => {
    const set = parseSandboxUiAllowedPorts('80, 443, 8080')
    expect([...set].sort((a, b) => a - b)).toEqual([80, 443, 8080])
  })

  it('rejects an empty list', () => {
    expect(() => parseSandboxUiAllowedPorts('')).toThrow(/at least one port/)
  })

  it('rejects out-of-range', () => {
    expect(() => parseSandboxUiAllowedPorts('70000')).toThrow(/invalid port/)
  })

  it('rejects non-numeric', () => {
    expect(() => parseSandboxUiAllowedPorts('abc')).toThrow(/invalid port/)
  })
})

describe('parseArtifactDownloadMaxBytes', () => {
  it('converts megabytes to bytes', () => {
    expect(parseArtifactDownloadMaxBytes('50')).toBe(50 * 1024 * 1024)
  })

  it('accepts fractional megabytes for small local caps', () => {
    expect(parseArtifactDownloadMaxBytes('0.5')).toBe(512 * 1024)
  })

  it('rejects zero and negative values', () => {
    expect(() => parseArtifactDownloadMaxBytes('0')).toThrow(/must be > 0/)
    expect(() => parseArtifactDownloadMaxBytes('-1')).toThrow(/must be > 0/)
  })

  it('rejects non-numeric values', () => {
    expect(() => parseArtifactDownloadMaxBytes('big')).toThrow(/invalid value/)
  })
})

describe('parsePositiveInt (stream admission caps)', () => {
  it('accepts a positive integer', () => {
    expect(parsePositiveInt('RPC_PROXY_STREAM_MAX_PER_USER', '7')).toBe(7)
  })

  it('trims surrounding whitespace', () => {
    expect(parsePositiveInt('RPC_PROXY_STREAM_MAX_PER_USER', ' 7 ')).toBe(7)
  })

  it('rejects an invalid value and names the variable', () => {
    expect(() => parsePositiveInt('RPC_PROXY_STREAM_MAX_PER_USER', 'abc')).toThrow(
      'RPC_PROXY_STREAM_MAX_PER_USER contains invalid value "abc" (must be a positive integer)'
    )
    // The message echoes the trimmed input, so a whitespace-only value shows as empty.
    expect(() => parsePositiveInt('RPC_PROXY_STREAM_MAX_PER_USER', ' ')).toThrow(
      'RPC_PROXY_STREAM_MAX_PER_USER contains invalid value "" (must be a positive integer)'
    )
    expect(() => parsePositiveInt('RPC_PROXY_STREAM_MAX_PER_USER', 'Infinity')).toThrow(
      'RPC_PROXY_STREAM_MAX_PER_USER contains invalid value "Infinity" (must be a positive integer)'
    )
  })

  it('accepts a numeric form that evaluates to a positive integer, as the timeouts do', () => {
    expect(parsePositiveInt('RPC_PROXY_STREAM_MAX_PER_USER', '1e3')).toBe(1000)
    expect(parsePositiveInt('RPC_PROXY_STREAM_MAX_PER_USER', '0x10')).toBe(16)
  })
})

describe('parsePositiveIntMs (wake-and-hold intervals)', () => {
  it('accepts positive integers', () => {
    expect(parsePositiveIntMs('RPC_PROXY_WAKE_MAX_HOLD_MS', '90000')).toBe(90000)
    expect(parsePositiveIntMs('RPC_PROXY_WAKE_POLL_MS', ' 2000 ')).toBe(2000)
  })

  it('rejects zero and negative values', () => {
    expect(() => parsePositiveIntMs('RPC_PROXY_WAKE_POLL_MS', '0')).toThrow(
      /must be a positive integer/
    )
    expect(() => parsePositiveIntMs('RPC_PROXY_WAKE_POLL_MS', '-5')).toThrow(
      /must be a positive integer/
    )
  })

  it('rejects non-integers and non-numeric values', () => {
    expect(() => parsePositiveIntMs('RPC_PROXY_WAKE_RETRIGGER_MS', '1.5')).toThrow(
      /must be a positive integer/
    )
    expect(() => parsePositiveIntMs('RPC_PROXY_WAKE_RETRIGGER_MS', 'soon')).toThrow(
      /must be a positive integer/
    )
  })
})

// NEW-rpx-2: setTimeout / AbortSignal.timeout treat a delay above 2^31-1 as 1 ms,
// so an oversized value would turn a generous deadline into an instant abort.
describe('parsePositiveIntMs timer bound', () => {
  it('accepts the largest delay a timer can honour', () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647)
    expect(parsePositiveIntMs('RPC_PROXY_UPSTREAM_TIMEOUT_MS', '2147483647')).toBe(2_147_483_647)
  })

  it('rejects a value one above the timer bound', () => {
    expect(() => parsePositiveIntMs('RPC_PROXY_UPSTREAM_TIMEOUT_MS', '2147483648')).toThrow(
      /RPC_PROXY_UPSTREAM_TIMEOUT_MS.*at most 2147483647/
    )
  })
})

describe('parseWakeMaxHoldMs', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('honours a value within the request hold cap without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(parseWakeMaxHoldMs('30000')).toBe(30_000)
    expect(parseWakeMaxHoldMs(String(MAX_REQUEST_HOLD_MS))).toBe(MAX_REQUEST_HOLD_MS)
    expect(warn).not.toHaveBeenCalled()
  })

  it('clamps a larger value to the cap and says so loudly at config load', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(parseWakeMaxHoldMs('90000')).toBe(MAX_REQUEST_HOLD_MS)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(
      /RPC_PROXY_WAKE_MAX_HOLD_MS=90000.*clamped to 48000/
    )
  })

  it('still rejects an invalid value instead of clamping it', () => {
    expect(() => parseWakeMaxHoldMs('0')).toThrow(/RPC_PROXY_WAKE_MAX_HOLD_MS.*positive integer/)
    expect(() => parseWakeMaxHoldMs('2147483648')).toThrow(/at most 2147483647/)
  })
})

describe('config values loaded from the environment', () => {
  // Each stream admission cap is compared with `>=` in its route's 429 check
  // (rpcHostStatusStream.ts, rpcHostActivityStream.ts): NaN turns the cap off and
  // 0 rejects every stream, so a value that does not read as a whole number of at
  // least 1 must stop startup.
  const STREAM_CAPS = [
    ['RPC_PROXY_STREAM_MAX_CONCURRENT', 'streamMaxConcurrent', 1000],
    ['RPC_PROXY_STREAM_MAX_PER_USER', 'streamMaxPerUser', 3],
    ['RPC_PROXY_STREAM_MAX_PER_USER_HOST', 'streamMaxPerUserHost', 1],
    ['RPC_PROXY_ACTIVITY_STREAM_MAX_CONCURRENT', 'activityStreamMaxConcurrent', 1000],
    ['RPC_PROXY_ACTIVITY_STREAM_MAX_PER_USER', 'activityStreamMaxPerUser', 3],
    ['RPC_PROXY_ACTIVITY_STREAM_MAX_PER_USER_HOST', 'activityStreamMaxPerUserHost', 1],
  ] as const
  // Before this change the caps used bare `Number()` and accepted every one of these:
  // `abc` (NaN) and `Infinity` turned the cap off, `0`, `-1` and `' '` (0) rejected
  // every stream, and `1.5` acted as a cap of 2. All of them are startup errors now.
  const INVALID_STREAM_CAPS = ['abc', '0', '-1', '1.5', ' ', 'Infinity']
  const ENV_KEYS = [
    'RPC_PROXY_UPSTREAM_TIMEOUT_MS',
    'RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS',
    'RPC_PROXY_WAKE_MAX_HOLD_MS',
    ...STREAM_CAPS.map(([key]) => key),
  ]
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    vi.resetModules()
    vi.restoreAllMocks()
  })

  async function loadConfig() {
    vi.resetModules()
    return (await import('../config.js')).config
  }

  it('loads RPC_PROXY_UPSTREAM_TIMEOUT_MS as an integer', async () => {
    process.env.RPC_PROXY_UPSTREAM_TIMEOUT_MS = '45000'
    expect((await loadConfig()).upstreamTimeoutMs).toBe(45_000)
  })

  it.each(['abc', '0', '-1', '1.5', '2147483648'])(
    'fails loud on RPC_PROXY_UPSTREAM_TIMEOUT_MS=%s',
    async value => {
      process.env.RPC_PROXY_UPSTREAM_TIMEOUT_MS = value
      await expect(loadConfig()).rejects.toThrow(/RPC_PROXY_UPSTREAM_TIMEOUT_MS/)
    }
  )

  it('loads RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS and rejects an oversized one', async () => {
    process.env.RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS = '120000'
    expect((await loadConfig()).artifactDownloadTimeoutMs).toBe(120_000)

    process.env.RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS = '2147483648'
    await expect(loadConfig()).rejects.toThrow(/RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS/)
  })

  it('defaults the upstream timeout, the artifact download timeout and the per-user-host cap', async () => {
    delete process.env.RPC_PROXY_UPSTREAM_TIMEOUT_MS
    delete process.env.RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS
    delete process.env.RPC_PROXY_ACTIVITY_STREAM_MAX_PER_USER_HOST
    const loaded = await loadConfig()
    expect(loaded.upstreamTimeoutMs).toBe(8_000)
    expect(loaded.artifactDownloadTimeoutMs).toBe(100_000)
    expect(loaded.activityStreamMaxPerUserHost).toBe(1)
  })

  it('an explicit value still overrides each of those defaults', async () => {
    process.env.RPC_PROXY_UPSTREAM_TIMEOUT_MS = '45000'
    process.env.RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS = '120000'
    process.env.RPC_PROXY_ACTIVITY_STREAM_MAX_PER_USER_HOST = '2'
    const loaded = await loadConfig()
    expect(loaded.upstreamTimeoutMs).toBe(45_000)
    expect(loaded.artifactDownloadTimeoutMs).toBe(120_000)
    expect(loaded.activityStreamMaxPerUserHost).toBe(2)
  })

  it.each(STREAM_CAPS)(
    'defaults %s (config.%s) to %i when it is unset or empty',
    async (key, field, defaultValue) => {
      delete process.env[key]
      expect((await loadConfig())[field]).toBe(defaultValue)
      process.env[key] = ''
      expect((await loadConfig())[field]).toBe(defaultValue)
    }
  )

  it.each(STREAM_CAPS)('trims and accepts a padded %s (config.%s)', async (key, field) => {
    process.env[key] = ' 7 '
    expect((await loadConfig())[field]).toBe(7)
  })

  it.each(STREAM_CAPS.flatMap(([key]) => INVALID_STREAM_CAPS.map(value => [key, value])))(
    'fails loud on %s=%s',
    async (key, value) => {
      process.env[key] = value
      // The error echoes the trimmed input, so `' '` reports an empty value.
      await expect(loadConfig()).rejects.toThrow(
        `${key} contains invalid value "${value.trim()}" (must be a positive integer)`
      )
    }
  )

  it('clamps RPC_PROXY_WAKE_MAX_HOLD_MS above the cap in the loaded config', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    process.env.RPC_PROXY_WAKE_MAX_HOLD_MS = '90000'
    expect((await loadConfig()).wakeMaxHoldMs).toBe(MAX_REQUEST_HOLD_MS)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('clamped to 48000'))
  })

  it('the built-in default is the hold cap itself, so it needs no clamp and no boot-time warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    delete process.env.RPC_PROXY_WAKE_MAX_HOLD_MS
    expect((await loadConfig()).wakeMaxHoldMs).toBe(48_000)
    expect(MAX_REQUEST_HOLD_MS).toBe(48_000)
    // The literal control-api's host-wake rate-limit guard reads must be the
    // effective default (not a larger value that is clamped at load).
    const source = readFileSync(new URL('../config.ts', import.meta.url), 'utf-8')
    expect(source).toMatch(/RPC_PROXY_WAKE_MAX_HOLD_MS\s*\|\|\s*'48000'/)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('minikube rpc-proxy ConfigMap', () => {
  const overlay = readFileSync(
    resolve(__dirname, '../../../deploy/overlays/minikube/configmaps/rpc-proxy-config.yaml'),
    'utf8'
  )

  function value(key: string): number {
    const match = overlay.match(new RegExp(`^\\s+${key}:\\s+"(\\d+)"\\s*$`, 'm'))
    if (!match) throw new Error(`${key} is missing from the minikube rpc-proxy ConfigMap`)
    return Number(match[1])
  }

  it('sets an artifact download timeout sized for the largest response rpc-proxy accepts', () => {
    const timeoutMs = value('RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS')
    // rpc-proxy answers 413 to a response above RPC_PROXY_ARTIFACT_DOWNLOAD_MAX_MB, from
    // its Content-Length or while reading it (readArtifactResponseBuffer in routes/rpc.ts),
    // so that cap is the largest body this timer has to move.
    const proxyCapMiB = value('RPC_PROXY_ARTIFACT_DOWNLOAD_MAX_MB')
    expect(parseArtifactDownloadMaxBytes(String(proxyCapMiB))).toBe(proxyCapMiB * 1024 * 1024)
    // The Host checks its own cap on the file before it redacts it, and redaction can make
    // the response longer, so the Host cap does not bound the response. A proxy cap below
    // it would reject files the Host serves.
    const artifactPaths = readFileSync(
      resolve(__dirname, '../../../mcp-host/src/workflow/artifactPaths.ts'),
      'utf8'
    )
    const cap = artifactPaths.match(/^export const MAX_ARTIFACT_BYTES = (\d+) \* 1024 \* 1024$/m)
    if (!cap) throw new Error('MAX_ARTIFACT_BYTES (in MiB) is missing from artifactPaths.ts')
    const hostCapMiB = Number(cap[1])
    expect(hostCapMiB).toBe(50)
    expect(proxyCapMiB).toBeGreaterThanOrEqual(hostCapMiB)
    // The overlay must move its largest accepted body at 1 MiB/s or slower.
    const requiredMiBPerSecond = proxyCapMiB / (timeoutMs / 1000)
    expect(requiredMiBPerSecond).toBeLessThanOrEqual(1)
    // ...and the timer must load through the same parser as production.
    expect(parsePositiveIntMs('RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS', String(timeoutMs))).toBe(
      timeoutMs
    )
  })
})

describe('secrets have no code default in any NODE_ENV', () => {
  // [env var, config field, the script that writes it in a cluster]
  const SECRETS = [
    [
      'RPC_PROXY_CONTROL_API_SERVICE_TOKEN',
      'controlApiServiceToken',
      'apply-inter-service-tokens.sh',
    ],
    ['RPC_PROXY_DESKTOP_COOKIE_SECRET', 'desktopCookieSecret', 'gen-jwt-keys.sh'],
    ['RPC_PROXY_SANDBOX_UI_COOKIE_SECRET', 'sandboxUiCookieSecret', 'gen-jwt-keys.sh'],
    // Must equal HCC's CONTEXT_MAPPER_DESKTOP_API_TOKEN.
    ['RPC_PROXY_DESKTOP_API_TOKEN', 'desktopApiToken', 'gen-jwt-keys.sh'],
  ] as const

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function importConfig() {
    vi.resetModules()
    return (await import('../config.js')).config
  }

  it('reads each secret from the environment on the non-production path', async () => {
    // The dev-default branch only exists outside production; prove these cases run there.
    expect(process.env.NODE_ENV).not.toBe('production')
    for (const [name] of SECRETS) vi.stubEnv(name, `${name.toLowerCase()}-value`)

    const config = await importConfig()

    for (const [name, field] of SECRETS) expect(config[field]).toBe(`${name.toLowerCase()}-value`)
  })

  it.each(SECRETS)('refuses to start when %s is unset', async name => {
    vi.stubEnv(name, undefined)

    await expect(importConfig()).rejects.toThrow(`Missing required environment variable: ${name}`)
  })

  it.each(SECRETS)(
    'refuses to start when %s is a replace-with-* placeholder',
    async (name, _field, writer) => {
      vi.stubEnv(name, 'replace-with-a-real-value')

      await expect(importConfig()).rejects.toThrow(
        new RegExp(
          `${name} has placeholder value .*Run deploy/scripts/${writer.replace('.', '\\.')}`
        )
      )
    }
  )

  it.each(SECRETS)('refuses to start when %s is empty', async name => {
    vi.stubEnv(name, '')

    await expect(importConfig()).rejects.toThrow(`Missing required environment variable: ${name}`)
  })

  it.each(SECRETS.flatMap(secret => [[...secret, '   '] as const, [...secret, '\n'] as const]))(
    'refuses to start when %s is only whitespace',
    async (name, _field, _writer, value) => {
      vi.stubEnv(name, value)

      await expect(importConfig()).rejects.toThrow(`Missing required environment variable: ${name}`)
    }
  )

  it.each(SECRETS)(
    'refuses a replace-with-* placeholder in %s after trimming surrounding spaces',
    async (name, _field, writer) => {
      vi.stubEnv(name, '  replace-with-a-real-value')

      await expect(importConfig()).rejects.toThrow(
        new RegExp(
          `${name} has placeholder value .*Run deploy/scripts/${writer.replace('.', '\\.')}`
        )
      )
    }
  )

  it.each(SECRETS)('loads %s without its surrounding whitespace', async (name, field) => {
    const value = `${name.toLowerCase()}-value`
    vi.stubEnv(name, `  ${value}\n`)

    expect((await importConfig())[field]).toBe(value)
  })

  // The two cookie secrets are the HMAC keys of the desktop and sandbox-UI session cookies.
  const COOKIE_SECRETS = SECRETS.filter(([name]) => name.endsWith('_COOKIE_SECRET'))

  it('covers both cookie secrets', () => {
    expect(COOKIE_SECRETS.map(([name]) => name)).toEqual([
      'RPC_PROXY_DESKTOP_COOKIE_SECRET',
      'RPC_PROXY_SANDBOX_UI_COOKIE_SECRET',
    ])
  })

  it.each(COOKIE_SECRETS)(
    'refuses to start when %s is shorter than 32 bytes, without echoing it',
    async name => {
      const short = 'q'.repeat(31)
      vi.stubEnv(name, short)

      const failure = importConfig()
      await expect(failure).rejects.toThrow(
        new RegExp(`${name} must be at least 32 bytes\\. Run deploy/scripts/gen-jwt-keys\\.sh`)
      )
      await expect(failure).rejects.not.toThrow(short)
      await expect(failure).rejects.not.toThrow(/\b31\b/)
    }
  )

  it.each(COOKIE_SECRETS)('accepts %s of exactly 32 bytes', async (name, field) => {
    const value = 'q'.repeat(32)
    vi.stubEnv(name, value)

    expect((await importConfig())[field]).toBe(value)
  })

  it.each(COOKIE_SECRETS)(
    'measures the %s minimum in UTF-8 bytes, not characters',
    async (name, field) => {
      // 16 characters, 32 bytes in UTF-8.
      const value = 'é'.repeat(16)
      vi.stubEnv(name, value)

      expect((await importConfig())[field]).toBe(value)
    }
  )

  it.each([
    ['RPC_PROXY_CONTROL_API_SERVICE_TOKEN', 'controlApiServiceToken'],
    ['RPC_PROXY_DESKTOP_API_TOKEN', 'desktopApiToken'],
  ] as const)('sets no minimum length on the bearer token %s', async (name, field) => {
    const value = 'nine-byte'
    vi.stubEnv(name, value)

    expect((await importConfig())[field]).toBe(value)
  })
})
