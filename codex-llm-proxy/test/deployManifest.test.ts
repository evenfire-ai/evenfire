import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONTROL_API_REQUEST_TIMEOUT_MS } from '../src/controlApiClient.js'
import { BODY_READ_DEADLINE_MS, STREAM_LIMITS } from '../src/requestLimits.js'

// The base manifest must agree with the limits this process enforces. Each
// check is a relation with a code constant, a recorded measurement or a
// recorded owner decision, so a change on either side fails here.

const MANIFEST = readFileSync(
  new URL('../../deploy/base/control-plane/codex-llm-proxy.yaml', import.meta.url),
  'utf-8'
)
const CONTROL_PLANE_CONFIG = readFileSync(
  new URL('../../deploy/base/control-plane/configmaps.yaml', import.meta.url),
  'utf-8'
)

/** Headroom between the last in-flight request finishing and SIGKILL. */
const SHUTDOWN_MARGIN_SECONDS = 20
/**
 * Heap cap the peak below was measured with. At 384 MiB the process aborts
 * while it parses the three admitted ordinary bodies when each one carries the
 * worst structure the contract admits (262144 containers, 262144 members,
 * 1048576 elements), before any stream reaches the upstream. 512 MiB is the
 * smallest cap that survives that load.
 */
const HEAP_CAP_MIB = 512
/**
 * The largest measured peak, heap capped at HEAP_CAP_MIB (tsc build, one
 * process, upstream request through undici, macOS, Node v24.18.0):
 * - D5 (#739): eight 8 MiB streams, two 24 MiB visual streams and three
 *   queued 8 MiB bodies with a text tool description: 790.3 MiB at a
 *   384 MiB cap;
 * - the same load with every ordinary body carrying the worst structure the
 *   contract admits (#806 Q1): 1094.9 and 1129.2 MiB in two runs at 512.
 *   That is the recorded peak.
 * Measured by hand, not by this suite (harness: 8 held streams, 3 queued
 * bodies, 2 visual bodies). Re-measure before changing it.
 */
const D5_CAPPED_PEAK_RSS_MIB = 1129.2
const MEMORY_HEADROOM = 1.25
/**
 * Owner decision on review M4 (#739): the request stays at 768Mi. It sits
 * below the limit, so the scheduler reserves what the ordinary load uses and
 * the worst-structure burst is covered by the limit alone.
 */
const MEMORY_REQUEST_MIB = 768

function activeLines(yaml: string): string[] {
  return yaml.split('\n').filter((line) => !line.trimStart().startsWith('#'))
}

/** The single value of `key:` among the non-comment lines, quotes removed. */
function scalar(yaml: string, key: string): string {
  const pattern = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`)
  const values = activeLines(yaml)
    .map((line) => pattern.exec(line)?.[1])
    .filter((value): value is string => value !== undefined)
  expect(values, `${key} must appear exactly once`).toHaveLength(1)
  return values[0]!.replace(/^['"]|['"]$/g, '')
}

function mebibytes(quantity: string): number {
  const match = /^(\d+)(Mi|Gi)$/.exec(quantity)
  expect(match, `unsupported memory quantity ${quantity}`).not.toBeNull()
  return Number(match![1]) * (match![2] === 'Gi' ? 1024 : 1)
}

/** `memory:` inside the container's `resources.<section>` block. */
function resourceMemory(section: 'requests' | 'limits'): number {
  const lines = activeLines(MANIFEST)
  const start = lines.findIndex((line) => line.trim() === `${section}:`)
  expect(start, `resources.${section} must exist`).toBeGreaterThanOrEqual(0)
  const memory = lines.slice(start + 1, start + 4).find((line) => /^\s*memory:/.test(line))
  expect(memory, `resources.${section}.memory must exist`).toBeDefined()
  return mebibytes(memory!.split(':')[1]!.trim())
}

describe('codex-llm-proxy base manifest', () => {
  it('T-DEP-1 gives SIGTERM enough grace for the longest request already admitted', () => {
    const configuredStreamMs = Number(scalar(MANIFEST, 'CODEX_LLM_PROXY_MAX_STREAM_DURATION_MS'))
    expect(configuredStreamMs).toBeGreaterThan(0)
    const streamMs = Math.min(configuredStreamMs, STREAM_LIMITS.maxStreamDurationMs)
    // After SIGTERM the server stops accepting connections, but a request that
    // already arrived can still wait in the queue, read its body, redeem its
    // ticket, stream to the cap and finalize. finalizeQuietly retries a failed
    // finalize once, so finalize is budgeted as two control-api calls.
    const worstCaseMs =
      STREAM_LIMITS.maxQueueWaitMs +
      BODY_READ_DEADLINE_MS +
      CONTROL_API_REQUEST_TIMEOUT_MS + // redeem
      streamMs +
      2 * CONTROL_API_REQUEST_TIMEOUT_MS // finalize and its one retry
    const grace = Number(scalar(MANIFEST, 'terminationGracePeriodSeconds'))
    expect(grace).toBe(Math.ceil(worstCaseMs / 1000) + SHUTDOWN_MARGIN_SECONDS)
  })

  it('T-DEP-2 caps the heap below the memory limit, keeps the limit above the D5 peak and requests 768Mi', () => {
    const nodeOptions = activeLines(MANIFEST).findIndex((line) => /name:\s*NODE_OPTIONS\s*$/.test(line))
    expect(nodeOptions, 'the container must set NODE_OPTIONS').toBeGreaterThanOrEqual(0)
    const heap = /--max-old-space-size=(\d+)/.exec(activeLines(MANIFEST)[nodeOptions + 1] ?? '')
    expect(heap, 'NODE_OPTIONS must cap the heap').not.toBeNull()
    const limit = resourceMemory('limits')
    expect(Number(heap![1])).toBe(HEAP_CAP_MIB)
    expect(Number(heap![1])).toBeLessThan(limit)
    expect(resourceMemory('requests')).toBeLessThanOrEqual(limit)
    expect(resourceMemory('requests')).toBe(MEMORY_REQUEST_MIB)
    expect(limit).toBeGreaterThanOrEqual(Math.ceil(D5_CAPPED_PEAK_RSS_MIB * MEMORY_HEADROOM))
  })

  it('T-DEP-3 keeps the Codex subscription off in base, as keyper-labs/evenfire-infra CI requires', () => {
    expect(scalar(MANIFEST, 'CODEX_LLM_PROXY_EXECUTION_ENABLED')).toBe('false')
    expect(scalar(CONTROL_PLANE_CONFIG, 'CONTROL_API_CODEX_SUBSCRIPTION_ENABLED')).toBe('false')
    // Witness for the absence below: the file is the control-plane config that
    // carries the MCP Host settings.
    expect(scalar(CONTROL_PLANE_CONFIG, 'MCP_HOST_JWT_CONTROL_TTL_SEC')).toBe('600')
    expect(activeLines(CONTROL_PLANE_CONFIG).some((line) => /MCP_HOST_CODEX_SUBSCRIPTION_ENABLED/.test(line))).toBe(false)
  })
})
