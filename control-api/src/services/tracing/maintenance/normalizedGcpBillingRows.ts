import type { NormalizedGcpBillingRow } from './contracts.js'
import { Decimal9 } from './decimal.js'

const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY = /^[A-Z]{3}$/
const SHA256 = /^[0-9a-f]{64}$/
const ALLOCATION_STATUSES = new Set([
  'allocated',
  'kube:system-overhead',
  'kube:unallocated',
  'goog-k8s-unknown',
  'goog-k8s-unsupported-sku',
  'missing-label',
  'non-gke-shared',
])
const STRING_FIELDS = [
  'usageUtcDay',
  'cloudProjectId',
  'clusterLocation',
  'clusterName',
  'environment',
  'namespace',
  'workloadKind',
  'workloadRef',
  'providerService',
  'providerSku',
  'currency',
  'allocationStatus',
  'amount',
  'sourceSha256',
  'billingViewVersion',
  'exportWatermark',
] as const

export function isUtcDay(value: string): boolean {
  if (!UTC_DAY.test(value)) return false
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}

export function parseNormalizedGcpBillingRows(input: {
  rows: readonly unknown[]
  source: string
}): NormalizedGcpBillingRow[] {
  return input.rows.map(value => {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`${input.source} row must be an object`)
    }
    const row = value as Record<string, unknown>
    if (row.schemaVersion !== 'gcp-billing-v1') {
      throw new Error(`${input.source} schema drift`)
    }
    for (const field of STRING_FIELDS) {
      if (typeof row[field] !== 'string' || row[field].length === 0) {
        throw new Error(`${input.source} row missing ${field}`)
      }
      if (row[field].length > 512) {
        throw new Error(`${input.source} row exceeds ${field} limit`)
      }
    }
    if (!['usage', 'credit', 'adjustment'].includes(String(row.costType))) {
      throw new Error(`${input.source} row has invalid costType`)
    }
    if (!ALLOCATION_STATUSES.has(String(row.allocationStatus))) {
      throw new Error(`${input.source} row has invalid allocationStatus`)
    }
    const usageUtcDay = String(row.usageUtcDay)
    if (!isUtcDay(usageUtcDay)) {
      throw new Error(`${input.source} row has invalid usageUtcDay`)
    }
    if (!CURRENCY.test(String(row.currency))) {
      throw new Error(`${input.source} row has invalid currency`)
    }
    Decimal9.parse(String(row.amount))
    if (!SHA256.test(String(row.sourceSha256))) {
      throw new Error(`${input.source} row has invalid sourceSha256`)
    }
    if (!Number.isFinite(Date.parse(String(row.exportWatermark)))) {
      throw new Error(`${input.source} row has invalid exportWatermark`)
    }
    if (!Number.isSafeInteger(row.sourceRowCount) || Number(row.sourceRowCount) <= 0) {
      throw new Error(`${input.source} row has invalid sourceRowCount`)
    }
    return {
      schemaVersion: 'gcp-billing-v1',
      usageUtcDay,
      cloudProjectId: String(row.cloudProjectId),
      clusterLocation: String(row.clusterLocation),
      clusterName: String(row.clusterName),
      environment: String(row.environment),
      namespace: String(row.namespace),
      workloadKind: String(row.workloadKind),
      workloadRef: String(row.workloadRef),
      providerService: String(row.providerService),
      providerSku: String(row.providerSku),
      currency: String(row.currency),
      costType: row.costType as NormalizedGcpBillingRow['costType'],
      allocationStatus: row.allocationStatus as NormalizedGcpBillingRow['allocationStatus'],
      amount: String(row.amount),
      sourceRowCount: Number(row.sourceRowCount),
      sourceSha256: String(row.sourceSha256),
      billingViewVersion: String(row.billingViewVersion),
      exportWatermark: new Date(String(row.exportWatermark)).toISOString(),
    }
  })
}
