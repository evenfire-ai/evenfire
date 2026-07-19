import type { GovernedTraceEvent } from '@lib/governedTrace'

export type InfrastructureOperationalSnapshotProps = {
  events: readonly GovernedTraceEvent[]
}
