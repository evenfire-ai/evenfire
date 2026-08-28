import type { FileHandle } from 'node:fs/promises'

interface FixtureLeaseTarget {
  filePath: string
}

export interface FixtureHandle {
  truncate(length: number): Promise<void>
  close(): Promise<void>
}

interface FixtureLease {
  handle: FixtureHandle
  state: 'active' | 'disposing' | 'disposed' | 'neutralize-failed-closed' | 'close-failed'
  neutralized: boolean
  disposeInFlight?: Promise<void>
  failure?: unknown
  neutralizeFailure?: unknown
}

const fixtureLeases = new WeakMap<FixtureLeaseTarget, FixtureLease>()
let fixtureHandleForTest:
  | ((handle: FileHandle, fixture: FixtureLeaseTarget) => FixtureHandle)
  | undefined

/** Test-only seam for exercising retained-handle disposal failures. */
export function setFixtureHandleForTest(
  hook: ((handle: FileHandle, fixture: FixtureLeaseTarget) => FixtureHandle) | undefined
): void {
  fixtureHandleForTest = hook
}

export function registerFixtureLeaseForTest(
  fixture: FixtureLeaseTarget,
  handle: FileHandle
): FixtureHandle {
  const lease: FixtureLease = {
    handle,
    state: 'active',
    neutralized: false,
  }
  fixtureLeases.set(fixture, lease)
  const ownedHandle = fixtureHandleForTest?.(handle, fixture) ?? handle
  lease.handle = ownedHandle
  return ownedHandle
}

export async function closeUnregisteredFixtureHandleForTest(handle: FileHandle): Promise<void> {
  await handle.close()
}

export function hasFixtureLeaseForTest(fixture: FixtureLeaseTarget): boolean {
  return fixtureLeases.has(fixture)
}

export async function disposeFixtureLeaseForTest(fixture: FixtureLeaseTarget): Promise<void> {
  const lease = fixtureLeases.get(fixture)
  if (!lease) {
    throw new Error(`refusing to neutralize an unowned GFS v2 fixture: ${fixture.filePath}`)
  }
  if (lease.disposeInFlight) return lease.disposeInFlight
  const operation = runFixtureLeaseDisposal(fixture, lease)
  lease.disposeInFlight = operation
  try {
    await operation
  } finally {
    lease.disposeInFlight = undefined
  }
}

async function runFixtureLeaseDisposal(
  fixture: FixtureLeaseTarget,
  lease: FixtureLease
): Promise<void> {
  if (lease.state === 'disposed') return
  if (lease.state === 'neutralize-failed-closed') {
    throw (
      lease.failure ??
      new Error(`GFS v2 fixture disposal failed without a recorded cause: ${fixture.filePath}`)
    )
  }
  if (lease.state === 'close-failed') {
    await retryCloseAfterFailure(fixture, lease)
    return
  }
  if (lease.state === 'disposing') {
    throw new Error(`GFS v2 fixture disposal is already in progress: ${fixture.filePath}`)
  }
  lease.state = 'disposing'
  try {
    await lease.handle.truncate(0)
    lease.neutralized = true
  } catch (error) {
    await closeAfterNeutralizeFailure(lease, error)
  }
  try {
    await lease.handle.close()
    lease.state = 'disposed'
  } catch (error) {
    lease.failure = error
    lease.state = 'close-failed'
    throw error
  }
}

async function closeAfterNeutralizeFailure(lease: FixtureLease, failure: unknown): Promise<never> {
  lease.neutralizeFailure = failure
  try {
    await lease.handle.close()
  } catch (closeError) {
    lease.failure = combineFixtureDisposalFailures(lease.neutralized, failure, closeError)
    lease.state = 'close-failed'
    throw lease.failure
  }
  if (lease.neutralized) {
    lease.state = 'disposed'
  } else {
    lease.failure = failure
    lease.state = 'neutralize-failed-closed'
  }
  throw failure
}

async function retryCloseAfterFailure(
  fixture: FixtureLeaseTarget,
  lease: FixtureLease
): Promise<void> {
  const previousFailure =
    lease.failure ??
    new Error(`GFS v2 fixture disposal failed without a recorded cause: ${fixture.filePath}`)
  const neutralizeFailure = lease.neutralizeFailure ?? previousFailure
  try {
    await lease.handle.close()
  } catch (closeError) {
    lease.failure = combineFixtureDisposalFailures(lease.neutralized, previousFailure, closeError)
    throw lease.failure
  }
  if (lease.neutralized) {
    lease.state = 'disposed'
    return
  }
  lease.state = 'neutralize-failed-closed'
  lease.failure = neutralizeFailure
  throw neutralizeFailure
}

function combineFixtureDisposalFailures(
  neutralized: boolean,
  failure: unknown,
  closeError: unknown
): AggregateError {
  return new AggregateError(
    [failure, closeError],
    neutralized
      ? 'failed to close neutralized GFS v2 fixture'
      : 'failed to neutralize and close GFS v2 fixture'
  )
}
