export const COST_ALLOCATION_BUCKETS = [
  'platform_overhead',
  'kube:system-overhead',
  'kube:unallocated',
  'unsupported',
  'unmapped',
  'missing_label',
  'non_gke_shared',
  'unknown',
  'adjustment',
] as const

export type CostAllocationBucket = (typeof COST_ALLOCATION_BUCKETS)[number]
export type CostPublicationState = 'provisional' | 'finalized'
export type CostCompleteness = 'complete' | 'partial' | 'unavailable'

export interface InventoryWorkload {
  namespace: 'control-plane' | 'mcp-server' | 'sandbox-recipes'
  workloadKind: 'Deployment'
  workloadRef: string
  kubernetesUid: string | null
  metadataGeneration: number | null
  desiredReplicas: number
  observedReplicas: number
  readyReplicas: number
  cpuRequestNanoCores: bigint
  cpuLimitNanoCores: bigint
  memoryRequestBytes: bigint
  memoryLimitBytes: bigint
  stableLabels: Readonly<Record<string, string>>
}

export interface InventorySnapshot {
  observedAt: string
  resourceVersion: string
  complete: boolean
  workloads: readonly InventoryWorkload[]
  omittedAllowlistedWorkloads: readonly string[]
}

export interface InfrastructurePriceSnapshot {
  id: string
  cloudProvider: 'gcp'
  cloudProjectId: string
  region: string
  clusterClass: string
  resourceClass: 'cpu' | 'memory'
  unit: 'vCPU_hour' | 'GiB_hour'
  unitPrice: string
  currency: string
  effectiveFrom: string
  sourceRef: string
  sourceSha256: string
}

export type InfrastructurePriceSnapshotEvidence = Omit<InfrastructurePriceSnapshot, 'id'>

export interface DailyCostKey {
  utcDay: string
  cloudProvider: 'gcp'
  cloudProjectId: string
  clusterLocation: string
  clusterName: string
  environment: string
  namespace: string
  workloadKind: string
  workloadRef: string
  currency: string
}

export interface DailyCostComponent {
  componentKey: string
  resourceClass: 'cpu' | 'memory' | 'provider_sku' | 'allocation_bucket'
  allocationBucket: CostAllocationBucket | null
  unitHours: string | null
  priceSnapshotId: string | null
  providerService: string | null
  providerSku: string | null
  billingViewVersion: string | null
  sourceRowCount: number | null
  sourceSha256: string
  billingExportWatermark: string | null
  grossAmount: string
  creditsAmount: string
  netAmount: string
  priceSourceRef?: string | null
  priceEffectiveFrom?: string | null
  priceUnitPrice?: string | null
}

export interface DailyCostVersion {
  key: DailyCostKey
  valuationKind: 'estimated' | 'billed'
  selectedBasis: 'requested_capacity' | 'measured_usage' | 'gcp_request_allocation'
  publicationState: CostPublicationState
  completenessStatus: CostCompleteness
  asOfUtc: string
  sourceIntervalStart: string | null
  sourceIntervalEnd: string | null
  billingExportWatermark: string | null
  sourceCount: number
  sourceSha256: string
  grossAmount: string
  creditsAmount: string
  netAmount: string
  components: readonly DailyCostComponent[]
}

export interface PersistedDailyCostVersion extends DailyCostVersion {
  id: string
  rollupVersion: number
  predecessorVersion: number | null
}

export type GcpAllocationStatus =
  | 'allocated'
  | 'kube:system-overhead'
  | 'kube:unallocated'
  | 'goog-k8s-unknown'
  | 'goog-k8s-unsupported-sku'
  | 'missing-label'
  | 'non-gke-shared'

export interface NormalizedGcpBillingRow {
  schemaVersion: 'gcp-billing-v1'
  usageUtcDay: string
  cloudProjectId: string
  clusterLocation: string
  clusterName: string
  environment: string
  namespace: string
  workloadKind: string
  workloadRef: string
  providerService: string
  providerSku: string
  currency: string
  costType: 'usage' | 'credit' | 'adjustment'
  allocationStatus: GcpAllocationStatus
  amount: string
  sourceRowCount: number
  sourceSha256: string
  billingViewVersion: string
  exportWatermark: string
}

export interface PeriodCostSelection {
  period: 'day' | 'week' | 'month'
  periodStartUtc: string
  periodEndUtc: string
  sourceDailyVersionHash: string
  dailyVersionVector: readonly { utcDay: string; id: string; rollupVersion: number }[]
  publicationState: CostPublicationState
  completenessStatus: CostCompleteness
  grossAmount: string
  creditsAmount: string
  netAmount: string
  overheadAmount: string
  unallocatedAmount: string
  unsupportedAmount: string
}
