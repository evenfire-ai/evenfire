/**
 * Prometheus metrics for the Host Context Controller (HCC).
 *
 * Uses a dedicated Registry to avoid polluting the global default registry.
 * Metrics follow the naming convention: clerum_hcc_<metric>_<unit>.
 */
import { Counter, Gauge, Registry } from 'prom-client'

export const registry = new Registry()

registry.setDefaultLabels({ service: 'host-context-controller' })

export const mcpServersTotal = new Gauge({
  name: 'clerum_hcc_mcpservers_total',
  help: 'Total number of McpServer CRDs tracked by HCC',
  labelNames: ['status'] as const,
  registers: [registry],
})

export const networkPoliciesTotal = new Gauge({
  name: 'clerum_hcc_networkpolicies_total',
  help: 'Total number of NetworkPolicies managed by HCC',
  labelNames: ['layer'] as const,
  registers: [registry],
})

export const contextReconciliationsTotal = new Counter({
  name: 'clerum_hcc_context_reconciliations_total',
  help: 'Total Context CRD reconciliations',
  labelNames: ['result'] as const,
  registers: [registry],
})

export const bindingReconciliationsTotal = new Counter({
  name: 'clerum_hcc_binding_reconciliations_total',
  help: 'Total binding policy reconciliations',
  labelNames: ['result'] as const,
  registers: [registry],
})

export const secretInformerEventsTotal = new Counter({
  name: 'clerum_hcc_secret_informer_events_total',
  help: 'Secret informer events received',
  labelNames: ['type'] as const,
  registers: [registry],
})

export const secretInformerReconnectsTotal = new Counter({
  name: 'clerum_hcc_secret_informer_reconnects_total',
  help: 'Secret informer reconnection attempts',
  registers: [registry],
})

export const secretInformerRunning = new Gauge({
  name: 'clerum_hcc_secret_informer_running',
  help: '1 when the SecretInformer watch is currently established, 0 when stopped or reconnecting',
  registers: [registry],
})

export const mcpserverMissingSecret = new Gauge({
  name: 'clerum_hcc_mcpserver_missing_secret',
  help: '1 when an McpServer references a non-existent Secret',
  labelNames: ['namespace', 'name', 'secret_name'] as const,
  registers: [registry],
})
