import { PR2_READINESS_HOPS, type Pr2ReadinessHop } from './pr2ReadinessContract.js'

export const PR2_RUNTIME_HOPS = PR2_READINESS_HOPS

export type Pr2RuntimeHop = Pr2ReadinessHop
export type Pr2RuntimeHopReadiness = Readonly<Record<Pr2RuntimeHop, 'ready' | 'unavailable'>>

export const unavailablePr2RuntimeHops: Pr2RuntimeHopReadiness = Object.freeze(
  Object.fromEntries(PR2_RUNTIME_HOPS.map(hop => [hop, 'unavailable'])) as Record<
    Pr2RuntimeHop,
    'unavailable'
  >
)

export function allPr2RuntimeHopsReady(
  readiness: Pr2RuntimeHopReadiness | null | undefined
): boolean {
  return Boolean(readiness) && PR2_RUNTIME_HOPS.every(hop => readiness?.[hop] === 'ready')
}
