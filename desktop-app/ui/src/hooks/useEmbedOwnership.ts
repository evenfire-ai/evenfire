import { useSyncExternalStore } from 'react'
import type { EmbedOwnershipState } from '../lib/embedOwnership.types'
import type { EmbedOwnershipMachine } from '../lib/embedOwnershipMachine.types'

export function useEmbedOwnership(machine: EmbedOwnershipMachine): EmbedOwnershipState {
  return useSyncExternalStore(machine.subscribe, machine.getSnapshot, machine.getSnapshot)
}
