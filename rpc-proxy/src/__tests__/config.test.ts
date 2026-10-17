import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MAX_REQUEST_HOLD_MS,
  MAX_TIMER_DELAY_MS,
  parseArtifactDownloadMaxBytes,
  parsePositiveIntMs,
  parseRpcProxyMcpHostEdgeToken,
  parseSandboxUiAllowedPorts,
  parseWakeMaxHoldMs,
} from '../config.js'

describe('parseRpcProxyMcpHostEdgeToken', () => {
  it('allows production startup without the dormant V2 credential', () => {
    expect(parseRpcProxyMcpHostEdgeToken(undefined, true)).toBe('')
  })

  it('accepts a bounded configured credential', () => {
    expect(parseRpcProxyMcpHostEdgeToken(' edge-token-value-32-bytes ', true)).toBe(
      'edge-token-value-32-bytes'
    )
  })

  it('rejects short or placeholder credentials', () => {
    expect(() => parseRpcProxyMcpHostEdgeToken('short', false)).toThrow(/16 to 4096/)
    expect(() => parseRpcProxyMcpHostEdgeToken('replace-with-edge-token', true)).toThrow(
      /placeholder/
    )
  })
})

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

describe('config timeouts loaded from the environment', () => {
  const ENV_KEYS = [
    'RPC_PROXY_UPSTREAM_TIMEOUT_MS',
    'RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS',
    'RPC_PROXY_WAKE_MAX_HOLD_MS',
  ] as const
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
    process.env.RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS = '300000'
    expect((await loadConfig()).artifactDownloadTimeoutMs).toBe(300_000)

    process.env.RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS = '2147483648'
    await expect(loadConfig()).rejects.toThrow(/RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS/)
  })

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

  it('sets an artifact download timeout sized for the 250 MB cap', () => {
    const timeoutMs = value('RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS')
    const maxMb = value('RPC_PROXY_ARTIFACT_DOWNLOAD_MAX_MB')
    expect(maxMb).toBe(250)
    // The 60 s default needs 4.2 MB/s to move 250 MB; the overlay must not.
    const requiredMbPerSecond = maxMb / (timeoutMs / 1000)
    expect(requiredMbPerSecond).toBeLessThanOrEqual(1)
    expect(timeoutMs).toBeGreaterThan(60_000)
    // ...and it must load through the same parser as production.
    expect(parsePositiveIntMs('RPC_PROXY_ARTIFACT_DOWNLOAD_TIMEOUT_MS', String(timeoutMs))).toBe(
      timeoutMs
    )
  })
})
