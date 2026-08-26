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
  state: 'active' | 'disposed' | 'neutralize-failed-closed' | 'close-failed'
  neutralized: boolean
  failure?: unknown
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
  const ownedHandle = fixtureHandleForTest?.(handle, fixture) ?? handle
  fixtureLeases.set(fixture, {
    handle: ownedHandle,
    state: 'active',
    neutralized: false,
  })
  return ownedHandle
}

export async function disposeFixtureLeaseForTest(fixture: FixtureLeaseTarget): Promise<void> {
  const lease = fixtureLeases.get(fixture)
  if (!lease) {
    throw new Error(`refusing to neutralize an unowned GFS v2 fixture: ${fixture.filePath}`)
  }
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
  try {
    await lease.handle.truncate(0)
    lease.neutralized = true
    await lease.handle.close()
    lease.state = 'disposed'
  } catch (error) {
    await closeAfterDisposalFailure(lease, error)
  }
}

async function closeAfterDisposalFailure(lease: FixtureLease, failure: unknown): Promise<never> {
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
  throw previousFailure
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
