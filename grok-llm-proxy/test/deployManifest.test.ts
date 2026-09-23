import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONTROL_API_REQUEST_TIMEOUT_MS } from '../src/controlApiClient.js'
import { BODY_READ_DEADLINE_MS, STREAM_LIMITS } from '../src/requestLimits.js'

// The base manifest must agree with the limits this process enforces. Each
// check is a relation with a code constant or a recorded measurement, so a
// change on either side that breaks the relation fails here.

const MANIFEST = readFileSync(
  new URL('../../deploy/base/control-plane/grok-llm-proxy.yaml', import.meta.url),
  'utf-8'
)
const CONTROL_PLANE_CONFIG = readFileSync(
  new URL('../../deploy/base/control-plane/configmaps.yaml', import.meta.url),
  'utf-8'
)

const WORKFLOW_RECIPES = readFileSync(
  new URL('../../deploy/base/control-plane/workflow-recipes.yaml', import.meta.url),
  'utf-8'
)

/** Headroom between the last in-flight request finishing and SIGKILL. */
const SHUTDOWN_MARGIN_SECONDS = 20
/**
 * D5 (#739): peak RSS with eight 8 MiB streams and three queued 8 MiB bodies,
 * heap capped at 384 MiB (tsc build, one process).
 */
const D5_CAPPED_PEAK_RSS_MIB = 509.8
const MEMORY_HEADROOM = 1.25

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

describe('grok-llm-proxy base manifest', () => {
  it('T-DEP-1 gives SIGTERM enough grace for the longest request already admitted', () => {
    const configuredStreamMs = Number(scalar(MANIFEST, 'GROK_LLM_PROXY_MAX_STREAM_DURATION_MS'))
    expect(configuredStreamMs).toBeGreaterThan(0)
    const streamMs = Math.min(configuredStreamMs, STREAM_LIMITS.maxStreamDurationMs)
    // After SIGTERM the server stops accepting connections, but a request that
    // already arrived can still wait in the queue, read its body, redeem its
    // ticket, stream to the cap and finalize.
    const worstCaseMs =
      STREAM_LIMITS.maxQueueWaitMs +
      BODY_READ_DEADLINE_MS +
      CONTROL_API_REQUEST_TIMEOUT_MS + // redeem
      streamMs +
      CONTROL_API_REQUEST_TIMEOUT_MS // finalize
    const grace = Number(scalar(MANIFEST, 'terminationGracePeriodSeconds'))
    expect(grace).toBe(Math.ceil(worstCaseMs / 1000) + SHUTDOWN_MARGIN_SECONDS)
  })

  it('T-DEP-2 caps the heap below the memory limit and keeps the limit above the D5 peak', () => {
    const nodeOptions = activeLines(MANIFEST).findIndex((line) => /name:\s*NODE_OPTIONS\s*$/.test(line))
    expect(nodeOptions, 'the container must set NODE_OPTIONS').toBeGreaterThanOrEqual(0)
    const heap = /--max-old-space-size=(\d+)/.exec(activeLines(MANIFEST)[nodeOptions + 1] ?? '')
    expect(heap, 'NODE_OPTIONS must cap the heap').not.toBeNull()
    const limit = resourceMemory('limits')
    expect(Number(heap![1])).toBeLessThan(limit)
    expect(resourceMemory('requests')).toBeLessThanOrEqual(limit)
    expect(limit).toBeGreaterThanOrEqual(Math.ceil(D5_CAPPED_PEAK_RSS_MIB * MEMORY_HEADROOM))
  })

  it('T-DEP-3 keeps the Grok subscription off in base, as keyper-labs/evenfire-infra CI requires', () => {
    expect(scalar(MANIFEST, 'GROK_LLM_PROXY_EXECUTION_ENABLED')).toBe('false')
    expect(scalar(CONTROL_PLANE_CONFIG, 'CONTROL_API_GROK_SUBSCRIPTION_ENABLED')).toBe('false')
    // Witness for the absence below: the file is the control-plane config that
    // carries the MCP Host settings.
    expect(scalar(CONTROL_PLANE_CONFIG, 'MCP_HOST_JWT_CONTROL_TTL_SEC')).toBe('600')
    expect(activeLines(CONTROL_PLANE_CONFIG).some((line) => /MCP_HOST_GROK_SUBSCRIPTION_ENABLED/.test(line))).toBe(false)
    // HCC injects the MCP Host switch per Host from its Grok projection.
    const recipes = activeLines(WORKFLOW_RECIPES)
    const wrc = recipes.findIndex((line) => /name:\s*WRC_GROK_SUBSCRIPTION_ENABLED\s*$/.test(line))
    expect(wrc, 'workflow-recipes must declare WRC_GROK_SUBSCRIPTION_ENABLED').toBeGreaterThanOrEqual(0)
    expect(recipes[wrc + 1]?.trim()).toBe('value: "false"')
  })
})
