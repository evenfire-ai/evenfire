import client, { Counter, Gauge } from 'prom-client'

export type RuntimeAuthHealthSnapshot = {
  state: 'ok' | 'degraded'
  consecutiveFailures: number
  lastFailureAt: string | null
  lastFailureReason: string | null
}

const DEFAULT_DEGRADED_AFTER_FAILURES = 3
const KNOWN_FAILURE_REASONS = new Set(['refresh_recovery_failed'])

let consecutiveFailures = 0
let lastFailureAt: string | null = null
let lastFailureReason: string | null = null

function getOrCreateCounter<Label extends string>(options: {
  name: string
  help: string
  labelNames: readonly Label[]
}): Counter<Label> {
  const existing = client.register.getSingleMetric(options.name)
  if (existing) return existing as Counter<Label>
  return new Counter<Label>({
    name: options.name,
    help: options.help,
    labelNames: options.labelNames as Label[],
  })
}

function getOrCreateGauge(options: { name: string; help: string }): Gauge<string> {
  const existing = client.register.getSingleMetric(options.name)
  if (existing) return existing as Gauge<string>
  return new Gauge<string>({
    name: options.name,
    help: options.help,
  })
}

export const runtimeAuthDegradedGauge = getOrCreateGauge({
  name: 'mcp_host_runtime_auth_degraded',
  help: '1 when runtime auth recovery is degraded, otherwise 0.',
})

export const runtimeAuthRecoveryFailuresCounter = getOrCreateCounter({
  name: 'mcp_host_runtime_auth_recovery_failures_total',
  help: 'Total runtime auth recovery failures labelled by low-cardinality reason.',
  labelNames: ['reason'] as const,
})

function degradedAfterFailures(): number {
  const raw = process.env.MCP_HOST_RUNTIME_AUTH_DEGRADED_AFTER_FAILURES
  if (!raw) return DEFAULT_DEGRADED_AFTER_FAILURES
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEGRADED_AFTER_FAILURES
}

function metricReason(reason: string): string {
  return KNOWN_FAILURE_REASONS.has(reason) ? reason : 'other'
}

function setDegradedGauge(): void {
  runtimeAuthDegradedGauge.set(consecutiveFailures >= degradedAfterFailures() ? 1 : 0)
}

export function recordRuntimeAuthRecoverySuccess(): void {
  consecutiveFailures = 0
  lastFailureAt = null
  lastFailureReason = null
  setDegradedGauge()
}

export function recordRuntimeAuthRecoveryFailure(reason: string): void {
  const safeReason = metricReason(reason)
  consecutiveFailures += 1
  lastFailureAt = new Date().toISOString()
  lastFailureReason = safeReason
  runtimeAuthRecoveryFailuresCounter.inc({ reason: safeReason }, 1)
  setDegradedGauge()
}

export function runtimeAuthHealthSnapshot(): RuntimeAuthHealthSnapshot {
  setDegradedGauge()
  return {
    state: consecutiveFailures >= degradedAfterFailures() ? 'degraded' : 'ok',
    consecutiveFailures,
    lastFailureAt,
    lastFailureReason,
  }
}

export function resetRuntimeAuthHealthForTests(): void {
  consecutiveFailures = 0
  lastFailureAt = null
  lastFailureReason = null
  setDegradedGauge()
}
