import { canonicalSha256 } from './canonical.js'
import type {
  CostAllocationBucket,
  DailyCostComponent,
  DailyCostKey,
  DailyCostVersion,
  GcpAllocationStatus,
  NormalizedGcpBillingRow,
} from './contracts.js'
import { Decimal9, sumDecimals } from './decimal.js'

function allocationBucket(status: GcpAllocationStatus): CostAllocationBucket | null {
  if (status === 'allocated') return null
  if (status === 'kube:system-overhead') return 'kube:system-overhead'
  if (status === 'kube:unallocated') return 'kube:unallocated'
  if (status === 'missing-label') return 'missing_label'
  if (status === 'non-gke-shared') return 'non_gke_shared'
  if (status === 'goog-k8s-unsupported-sku') return 'unsupported'
  if (status === 'goog-k8s-unknown') return 'unknown'
  return 'unmapped'
}

export interface GcpBillingReconciliationInput {
  key: DailyCostKey
  rows: readonly NormalizedGcpBillingRow[]
  asOfUtc: string
  publicationState: 'provisional' | 'finalized'
}

export function reconcileNormalizedGcpBilling(
  input: GcpBillingReconciliationInput
): DailyCostVersion {
  if (input.rows.length === 0) throw new Error('GCP billed reconciliation requires rows')
  const components: DailyCostComponent[] = input.rows.map((row, index) => {
    if (
      row.usageUtcDay !== input.key.utcDay ||
      row.cloudProjectId !== input.key.cloudProjectId ||
      row.clusterLocation !== input.key.clusterLocation ||
      row.clusterName !== input.key.clusterName ||
      row.environment !== input.key.environment ||
      row.namespace !== input.key.namespace ||
      row.workloadKind !== input.key.workloadKind ||
      row.workloadRef !== input.key.workloadRef ||
      row.currency !== input.key.currency
    )
      throw new Error('GCP billed row does not match the selected daily key')
    const amount = Decimal9.parse(row.amount)
    if (row.costType === 'credit' && !amount.isNegative()) {
      throw new Error('GCP credit rows must carry a negative amount')
    }
    const adjustmentCredit = row.costType === 'adjustment' && amount.isNegative()
    const credit = row.costType === 'credit' || adjustmentCredit ? amount : Decimal9.zero
    const gross = row.costType === 'credit' || adjustmentCredit ? Decimal9.zero : amount
    if (gross.isNegative()) throw new Error('GCP usage rows cannot carry a negative gross amount')
    const bucket =
      row.costType === 'adjustment' ? 'adjustment' : allocationBucket(row.allocationStatus)
    return {
      componentKey: `gcp:${row.providerService}:${row.providerSku}:${row.costType}:${row.allocationStatus}:${index}`,
      resourceClass: bucket ? 'allocation_bucket' : 'provider_sku',
      allocationBucket: bucket,
      unitHours: null,
      priceSnapshotId: null,
      providerService: row.providerService,
      providerSku: row.providerSku,
      billingViewVersion: row.billingViewVersion,
      sourceRowCount: row.sourceRowCount,
      sourceSha256: row.sourceSha256,
      billingExportWatermark: row.exportWatermark,
      grossAmount: gross.toString(),
      creditsAmount: credit.toString(),
      netAmount: gross.add(credit).toString(),
    }
  })
  const gross = sumDecimals(components.map(component => Decimal9.parse(component.grossAmount)))
  const credits = sumDecimals(components.map(component => Decimal9.parse(component.creditsAmount)))
  const watermarks = [...new Set(input.rows.map(row => row.exportWatermark))].sort()
  return {
    key: { ...input.key },
    valuationKind: 'billed',
    selectedBasis: 'gcp_request_allocation',
    publicationState: input.publicationState,
    completenessStatus: 'complete',
    asOfUtc: new Date(input.asOfUtc).toISOString(),
    sourceIntervalStart: null,
    sourceIntervalEnd: null,
    billingExportWatermark: watermarks.at(-1) ?? null,
    sourceCount: input.rows.reduce((sum, row) => sum + row.sourceRowCount, 0),
    sourceSha256: canonicalSha256(input.rows),
    grossAmount: gross.toString(),
    creditsAmount: credits.toString(),
    netAmount: gross.add(credits).toString(),
    components,
  }
}
