/**
 * Prometheus metrics for the Host Context Controller (HCC).
 *
 * Uses a dedicated Registry to avoid polluting the global default registry.
 * Metrics follow the naming convention: clerum_hcc_<metric>_<unit>.
 */
import { Counter, Gauge, Registry } from 'prom-client'

const REGISTRY_KEY = Symbol.for('clerum.hcc.prometheus.registry')
type MetricsGlobal = typeof globalThis & { [REGISTRY_KEY]?: Registry }
const metricsGlobal = globalThis as MetricsGlobal
const newRegistry = !metricsGlobal[REGISTRY_KEY]
export const registry = (metricsGlobal[REGISTRY_KEY] ??= new Registry())

if (newRegistry) registry.setDefaultLabels({ service: 'host-context-controller' })

function counter(options: {
  name: string
  help: string
  labelNames?: readonly string[]
}): Counter<string> {
  const existing = registry.getSingleMetric(options.name)
  if (existing) return existing as Counter<string>
  return new Counter({
    ...options,
    labelNames: [...(options.labelNames ?? [])],
    registers: [registry],
  })
}

function gauge(options: {
  name: string
  help: string
  labelNames?: readonly string[]
}): Gauge<string> {
  const existing = registry.getSingleMetric(options.name)
  if (existing) return existing as Gauge<string>
  return new Gauge({
    ...options,
    labelNames: [...(options.labelNames ?? [])],
    registers: [registry],
  })
}

export const mcpServersTotal = gauge({
  name: 'clerum_hcc_mcpservers_total',
  help: 'Total number of McpServer CRDs tracked by HCC',
  labelNames: ['status'] as const,
})

export const networkPoliciesTotal = gauge({
  name: 'clerum_hcc_networkpolicies_total',
  help: 'Total number of NetworkPolicies managed by HCC',
  labelNames: ['layer'] as const,
})

export const contextReconciliationsTotal = counter({
  name: 'clerum_hcc_context_reconciliations_total',
  help: 'Total Context CRD reconciliations',
  labelNames: ['result'] as const,
})

export const bindingReconciliationsTotal = counter({
  name: 'clerum_hcc_binding_reconciliations_total',
  help: 'Total binding policy reconciliations',
  labelNames: ['result'] as const,
})

export const secretInformerEventsTotal = counter({
  name: 'clerum_hcc_secret_informer_events_total',
  help: 'Secret informer events received',
  labelNames: ['type'] as const,
})

export const secretInformerReconnectsTotal = counter({
  name: 'clerum_hcc_secret_informer_reconnects_total',
  help: 'Secret informer reconnection attempts',
})

export const secretInformerRunning = gauge({
  name: 'clerum_hcc_secret_informer_running',
  help: '1 when the SecretInformer watch is currently established, 0 when stopped or reconnecting',
})

export const mcpserverMissingSecret = gauge({
  name: 'clerum_hcc_mcpserver_missing_secret',
  help: '1 when an McpServer references a non-existent Secret',
  labelNames: ['namespace', 'name', 'secret_name'] as const,
})

export const infrastructureTelemetryEnqueuedTotal = counter({
  name: 'clerum_hcc_infrastructure_telemetry_enqueued_total',
  help: 'Infrastructure telemetry projections accepted by the bounded HCC reporter.',
  labelNames: ['telemetry_type'] as const,
})

export const infrastructureTelemetryDroppedTotal = counter({
  name: 'clerum_hcc_infrastructure_telemetry_dropped_total',
  help: 'Infrastructure telemetry projections dropped by the bounded HCC reporter.',
  labelNames: ['telemetry_type', 'reason'] as const,
})

export const infrastructureTelemetryFlushesTotal = counter({
  name: 'clerum_hcc_infrastructure_telemetry_flushes_total',
  help: 'Completed HCC infrastructure telemetry flush attempts.',
  labelNames: ['result'] as const,
})

export const infrastructureTelemetryRetriesTotal = counter({
  name: 'clerum_hcc_infrastructure_telemetry_retries_total',
  help: 'Infrastructure telemetry retries scheduled after a failed flush.',
  labelNames: ['telemetry_type'] as const,
})

export const infrastructureTelemetryGapsTotal = counter({
  name: 'clerum_hcc_infrastructure_telemetry_gaps_total',
  help: 'Infrastructure telemetry evidence gaps that block complete trace or cost coverage.',
  labelNames: ['telemetry_type', 'reason'] as const,
})

export const administrativeOutcomeReporterTotal = counter({
  name: 'clerum_hcc_administrative_outcome_reporter_total',
  help: 'Administrative outcome reporter enqueue, flush, and drop outcomes.',
  labelNames: ['result'] as const,
})
