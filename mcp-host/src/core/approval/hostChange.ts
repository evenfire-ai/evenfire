import type { HostCRD } from '../../types'

/**
 * Publish this event's approval policy before the credential await, then
 * commit the host only if no newer event has started. `commitHost` may be
 * async; its rejection rejects this call.
 */
export async function applyHostChange(
  host: HostCRD,
  deps: {
    gate: { begin(): number; isLatest(generation: number): boolean }
    publishApproval(host: HostCRD): void
    ensureConfigStore(host: HostCRD): Promise<void>
    commitHost(host: HostCRD): void | Promise<void>
  }
): Promise<void> {
  const generation = deps.gate.begin()
  deps.publishApproval(host)
  await deps.ensureConfigStore(host)
  if (deps.gate.isLatest(generation)) {
    await deps.commitHost(host)
  }
}
