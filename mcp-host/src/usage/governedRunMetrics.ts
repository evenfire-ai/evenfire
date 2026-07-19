import { Counter, Histogram, register } from 'prom-client'

function getOrCreateCounter<Label extends string>(options: {
  name: string
  help: string
  labelNames: Label[]
}): Counter<Label> {
  const existing = register.getSingleMetric(options.name)
  if (existing) return existing as Counter<Label>
  return new Counter<Label>({ ...options, registers: [register] })
}

function getOrCreateHistogram<Label extends string>(options: {
  name: string
  help: string
  labelNames: Label[]
  buckets: number[]
}): Histogram<Label> {
  const existing = register.getSingleMetric(options.name)
  if (existing) return existing as Histogram<Label>
  return new Histogram<Label>({ ...options, registers: [register] })
}

export const governedRunEnqueuedTotal = getOrCreateCounter({
  name: 'clerum_mcp_host_governed_trace_enqueued_total',
  help: 'Governed run events accepted by the bounded mcp-host reporter.',
  labelNames: ['type', 'priority'] as const as Array<'type' | 'priority'>,
})

export const governedRunDroppedTotal = getOrCreateCounter({
  name: 'clerum_mcp_host_governed_trace_dropped_total',
  help: 'Governed run events dropped by the bounded mcp-host reporter.',
  labelNames: ['type', 'priority', 'reason'] as const as Array<'type' | 'priority' | 'reason'>,
})

export const governedRunGapsTotal = getOrCreateCounter({
  name: 'clerum_mcp_host_governed_trace_gaps_total',
  help: 'Critical governed run evidence gaps that make a trace incomplete.',
  labelNames: ['type', 'reason'] as const as Array<'type' | 'reason'>,
})

export const governedRunFlushesTotal = getOrCreateCounter({
  name: 'clerum_mcp_host_governed_trace_flushes_total',
  help: 'Governed run reporter delivery outcomes.',
  labelNames: ['result'] as const as Array<'result'>,
})

export const governedRunBatchSize = getOrCreateHistogram({
  name: 'clerum_mcp_host_governed_trace_batch_size',
  help: 'Governed run event count per delivery batch.',
  labelNames: [] as string[],
  buckets: [1, 2, 5, 10, 25, 50, 100],
})
