import { canonicalSha256 } from './canonical.js'
import type {
  CostCompleteness,
  CostPublicationState,
  DailyCostComponent,
  DailyCostKey,
  DailyCostVersion,
  InfrastructurePriceSnapshot,
} from './contracts.js'
import { Decimal9, sumDecimals } from './decimal.js'

const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const MILLISECONDS_PER_HOUR = 3_600_000n
const NANOCORES_PER_CORE = 1_000_000_000n
const BYTES_PER_GIB = 1_073_741_824n

export interface RequestedCapacityEstimateInput {
  key: DailyCostKey
  clusterClass: string
  intervalStart: string
  intervalEnd: string
  asOfUtc: string
  desiredReplicas: number
  cpuRequestNanoCores: bigint
  memoryRequestBytes: bigint
  priceSnapshots: readonly InfrastructurePriceSnapshot[]
  publicationState: CostPublicationState
  completenessStatus: Exclude<CostCompleteness, 'unavailable'>
  sourceCount: number
  sourceSha256: string
}

function parseInstant(value: string, field: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be a valid timestamp`)
  return timestamp
}

function dayBounds(utcDay: string): readonly [number, number] {
  if (!UTC_DAY_PATTERN.test(utcDay)) throw new Error('utcDay must be an ISO UTC date')
  const start = Date.parse(`${utcDay}T00:00:00.000Z`)
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== utcDay) {
    throw new Error('utcDay must be a real ISO UTC date')
  }
  return [start, start + Number(MILLISECONDS_PER_HOUR * 24n)]
}

function selectedPrice(
  input: RequestedCapacityEstimateInput,
  resourceClass: 'cpu' | 'memory'
): InfrastructurePriceSnapshot {
  const expectedUnit = resourceClass === 'cpu' ? 'vCPU_hour' : 'GiB_hour'
  const matching = input.priceSnapshots.filter(
    snapshot =>
      snapshot.cloudProvider === input.key.cloudProvider &&
      snapshot.cloudProjectId === input.key.cloudProjectId &&
      snapshot.region === input.key.clusterLocation &&
      snapshot.clusterClass === input.clusterClass &&
      snapshot.resourceClass === resourceClass &&
      snapshot.unit === expectedUnit &&
      snapshot.currency === input.key.currency
  )
  if (matching.length !== 1) {
    throw new Error(
      `requested-capacity estimate requires exactly one ${resourceClass} price snapshot`
    )
  }
  return matching[0]!
}

function buildComponent(
  resourceClass: 'cpu' | 'memory',
  unitHours: Decimal9,
  price: InfrastructurePriceSnapshot,
  intervalDigest: string
): DailyCostComponent {
  const gross = unitHours.multiply(Decimal9.parse(price.unitPrice))
  return {
    componentKey: `requested_capacity:${resourceClass}:${price.id}`,
    resourceClass,
    allocationBucket: null,
    unitHours: unitHours.toString(),
    priceSnapshotId: price.id,
    providerService: null,
    providerSku: null,
    billingViewVersion: null,
    sourceRowCount: null,
    sourceSha256: canonicalSha256({ intervalDigest, priceSnapshotId: price.id }),
    billingExportWatermark: null,
    grossAmount: gross.toString(),
    creditsAmount: Decimal9.zero.toString(),
    netAmount: gross.toString(),
  }
}

export function estimateRequestedCapacityDaily(
  input: RequestedCapacityEstimateInput
): DailyCostVersion {
  if (!Number.isSafeInteger(input.desiredReplicas) || input.desiredReplicas < 0) {
    throw new Error('desiredReplicas must be a non-negative safe integer')
  }
  if (input.cpuRequestNanoCores < 0n || input.memoryRequestBytes < 0n) {
    throw new Error('requested resource quantities must be non-negative')
  }
  if (!Number.isSafeInteger(input.sourceCount) || input.sourceCount <= 0) {
    throw new Error('sourceCount must be a positive safe integer')
  }
  if (!SHA256_PATTERN.test(input.sourceSha256)) throw new Error('sourceSha256 must be sha256')

  const intervalStart = parseInstant(input.intervalStart, 'intervalStart')
  const intervalEnd = parseInstant(input.intervalEnd, 'intervalEnd')
  const asOfUtc = parseInstant(input.asOfUtc, 'asOfUtc')
  const [dayStart, dayEnd] = dayBounds(input.key.utcDay)
  if (intervalEnd <= intervalStart) throw new Error('requested-capacity interval must be positive')
  if (intervalStart < dayStart || intervalEnd > dayEnd) {
    throw new Error('requested-capacity interval must stay within utcDay')
  }
  if (asOfUtc < intervalEnd) throw new Error('asOfUtc cannot precede intervalEnd')

  const cpuPrice = selectedPrice(input, 'cpu')
  const memoryPrice = selectedPrice(input, 'memory')
  if (input.priceSnapshots.length !== 2) {
    throw new Error(
      'requested-capacity estimate accepts only the selected cpu and memory snapshots'
    )
  }
  for (const price of [cpuPrice, memoryPrice]) {
    if (parseInstant(price.effectiveFrom, 'price effectiveFrom') > intervalStart) {
      throw new Error(`price snapshot ${price.id} is not effective for the interval`)
    }
    if (!SHA256_PATTERN.test(price.sourceSha256)) {
      throw new Error(`price snapshot ${price.id} has an invalid sourceSha256`)
    }
    if (Decimal9.parse(price.unitPrice).isNegative()) {
      throw new Error(`price snapshot ${price.id} cannot have a negative price`)
    }
  }

  const replicas = BigInt(input.desiredReplicas)
  const durationMs = BigInt(intervalEnd - intervalStart)
  const cpuUnitHours = Decimal9.fromRatio(
    input.cpuRequestNanoCores * replicas * durationMs,
    NANOCORES_PER_CORE * MILLISECONDS_PER_HOUR
  )
  const memoryUnitHours = Decimal9.fromRatio(
    input.memoryRequestBytes * replicas * durationMs,
    BYTES_PER_GIB * MILLISECONDS_PER_HOUR
  )
  const components = [
    buildComponent('cpu', cpuUnitHours, cpuPrice, input.sourceSha256),
    buildComponent('memory', memoryUnitHours, memoryPrice, input.sourceSha256),
  ]
  const gross = sumDecimals(components.map(item => Decimal9.parse(item.grossAmount)))
  const sourceSha256 = canonicalSha256({
    intervalDigest: input.sourceSha256,
    priceSnapshotIds: components.map(item => item.priceSnapshotId),
  })

  return {
    key: { ...input.key },
    valuationKind: 'estimated',
    selectedBasis: 'requested_capacity',
    publicationState: input.publicationState,
    completenessStatus: input.completenessStatus,
    asOfUtc: new Date(asOfUtc).toISOString(),
    sourceIntervalStart: new Date(intervalStart).toISOString(),
    sourceIntervalEnd: new Date(intervalEnd).toISOString(),
    billingExportWatermark: null,
    sourceCount: input.sourceCount,
    sourceSha256,
    grossAmount: gross.toString(),
    creditsAmount: Decimal9.zero.toString(),
    netAmount: gross.toString(),
    components,
  }
}
