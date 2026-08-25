export type GfsUploadProductEnvState = { kind: 'absent' } | { kind: 'explicit'; value: number }

export interface GfsUploadProductEnvPair {
  canonical: GfsUploadProductEnvState
  alias: GfsUploadProductEnvState
}

export interface GfsUploadProductMutationOwnership {
  context: string
  branch: string
  worktreeId: string
  gitHead: string
  clusterFingerprint: string
  preGateMarkerUid: string
}

export interface GfsUploadProductMutationMarker {
  version: 1
  state: 'recovery-required'
  holder: string
  startedAt: string
  ownership: GfsUploadProductMutationOwnership
  baseline: GfsUploadProductEnvPair
}

export interface GfsUploadProductMutationLease {
  uid: string
  marker: GfsUploadProductMutationMarker
}

export interface GfsUploadProductMutationAdapter {
  authorizeNewMutation(): Promise<GfsUploadProductMutationOwnership>
  authorizeRecovery(marker: GfsUploadProductMutationMarker): Promise<void>
  readBaseline(): Promise<GfsUploadProductEnvPair>
  readMarker(): Promise<GfsUploadProductMutationLease | undefined>
  createMarker(marker: GfsUploadProductMutationMarker): Promise<{ uid: string }>
  applyPair(pair: GfsUploadProductEnvPair): Promise<void>
  verifyPair(pair: GfsUploadProductEnvPair): Promise<void>
  deleteMarker(lease: GfsUploadProductMutationLease): Promise<void>
  newHolder(): string
  now(): string
  waitBeforeRetry(attempt: number): Promise<void>
}

const RESTORE_ATTEMPTS = 3

function sameState(left: GfsUploadProductEnvState, right: GfsUploadProductEnvState): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'absent' || (right.kind === 'explicit' && left.value === right.value))
  )
}

export function sameGfsUploadProductEnvPair(
  left: GfsUploadProductEnvPair,
  right: GfsUploadProductEnvPair
): boolean {
  return sameState(left.canonical, right.canonical) && sameState(left.alias, right.alias)
}

export function serializeGfsUploadProductMutationMarker(
  marker: GfsUploadProductMutationMarker
): string {
  return JSON.stringify(marker)
}

export function parseGfsUploadProductMutationMarker(raw: string): GfsUploadProductMutationMarker {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('invalid GFS Upload v2 product-limit recovery marker JSON')
  }
  if (!value || typeof value !== 'object') {
    throw new Error('invalid GFS Upload v2 product-limit recovery marker shape')
  }
  const marker = value as Partial<GfsUploadProductMutationMarker>
  const ownership = marker.ownership as Partial<GfsUploadProductMutationOwnership> | undefined
  if (
    marker.version !== 1 ||
    marker.state !== 'recovery-required' ||
    typeof marker.holder !== 'string' ||
    marker.holder.length === 0 ||
    typeof marker.startedAt !== 'string' ||
    marker.startedAt.length === 0 ||
    !ownership ||
    typeof ownership.context !== 'string' ||
    typeof ownership.branch !== 'string' ||
    typeof ownership.worktreeId !== 'string' ||
    typeof ownership.gitHead !== 'string' ||
    typeof ownership.clusterFingerprint !== 'string' ||
    typeof ownership.preGateMarkerUid !== 'string' ||
    !marker.baseline ||
    !isEnvState(marker.baseline.canonical) ||
    !isEnvState(marker.baseline.alias)
  ) {
    throw new Error('invalid GFS Upload v2 product-limit recovery marker shape')
  }
  return marker as GfsUploadProductMutationMarker
}

function isEnvState(value: unknown): value is GfsUploadProductEnvState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<GfsUploadProductEnvState>
  return (
    state.kind === 'absent' ||
    (state.kind === 'explicit' && Number.isSafeInteger(state.value) && (state.value as number) >= 1)
  )
}

function assertSameLease(
  expected: GfsUploadProductMutationLease,
  actual: GfsUploadProductMutationLease | undefined
): void {
  if (
    !actual ||
    actual.uid !== expected.uid ||
    actual.marker.holder !== expected.marker.holder ||
    serializeGfsUploadProductMutationMarker(actual.marker) !==
      serializeGfsUploadProductMutationMarker(expected.marker)
  ) {
    throw new Error(
      'GFS Upload v2 product-limit recovery marker changed; refusing mutation or cleanup'
    )
  }
}

export async function beginGfsUploadProductMutation(
  adapter: GfsUploadProductMutationAdapter
): Promise<GfsUploadProductMutationLease> {
  const ownership = await adapter.authorizeNewMutation()
  const existing = await adapter.readMarker()
  if (existing) {
    throw new Error(
      `GFS Upload v2 product-limit recovery is required for uid ${existing.uid}, ` +
        `holder ${existing.marker.holder}; explicitly confirm both lease values before restoring ` +
        'the recorded baseline or starting another mutation'
    )
  }
  const baseline = await adapter.readBaseline()
  const marker: GfsUploadProductMutationMarker = {
    version: 1,
    state: 'recovery-required',
    holder: adapter.newHolder(),
    startedAt: adapter.now(),
    ownership,
    baseline,
  }
  const created = await adapter.createMarker(marker)
  if (!created.uid) {
    throw new Error('GFS Upload v2 product-limit recovery marker has no immutable UID')
  }
  const lease = { uid: created.uid, marker }
  await adapter.authorizeRecovery(marker)
  assertSameLease(lease, await adapter.readMarker())
  return lease
}

export async function applyGfsUploadProductMutation(
  adapter: GfsUploadProductMutationAdapter,
  lease: GfsUploadProductMutationLease,
  pair: GfsUploadProductEnvPair
): Promise<void> {
  await adapter.authorizeRecovery(lease.marker)
  assertSameLease(lease, await adapter.readMarker())
  await adapter.applyPair(pair)
  await adapter.verifyPair(pair)
  await adapter.authorizeRecovery(lease.marker)
  assertSameLease(lease, await adapter.readMarker())
}

async function restoreWithRetries(
  adapter: GfsUploadProductMutationAdapter,
  lease: GfsUploadProductMutationLease
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt += 1) {
    try {
      await adapter.authorizeRecovery(lease.marker)
      assertSameLease(lease, await adapter.readMarker())
      await adapter.applyPair(lease.marker.baseline)
      await adapter.verifyPair(lease.marker.baseline)
      await adapter.authorizeRecovery(lease.marker)
      assertSameLease(lease, await adapter.readMarker())
      await adapter.deleteMarker(lease)
      return
    } catch (error) {
      lastError = error
      if (attempt < RESTORE_ATTEMPTS) await adapter.waitBeforeRetry(attempt)
    }
  }
  throw new Error(
    `GFS Upload v2 product-limit recovery remains required after ${RESTORE_ATTEMPTS} attempts; ` +
      `holder=${lease.marker.holder}; baseline=${JSON.stringify(lease.marker.baseline)}; ` +
      `cause=${lastError instanceof Error ? lastError.message : String(lastError)}`
  )
}

export async function restoreGfsUploadProductMutation(
  adapter: GfsUploadProductMutationAdapter,
  lease: GfsUploadProductMutationLease
): Promise<void> {
  await adapter.authorizeRecovery(lease.marker)
  await restoreWithRetries(adapter, lease)
}

export async function recoverGfsUploadProductMutation(
  adapter: GfsUploadProductMutationAdapter,
  expected: { uid: string; holder: string }
): Promise<boolean> {
  const lease = await adapter.readMarker()
  if (!lease) return false
  if (lease.uid !== expected.uid || lease.marker.holder !== expected.holder) {
    throw new Error('GFS Upload v2 product-limit recovery takeover evidence does not match')
  }
  await adapter.authorizeRecovery(lease.marker)
  await restoreWithRetries(adapter, lease)
  return true
}
