import { config } from '../config.js'
import type { K8sGateway } from '../k8s.js'
import { bumpWakeGeneration } from './hostWakeService.js'
import { K8sNotFoundError } from './resourceService.js'

export const WAKE_REQUESTED_ANNOTATION = 'clerum.io/wake-requested'

export type HostWakeActionResult =
  | Readonly<{ kind: 'active'; wakeGeneration: number | null }>
  | Readonly<{ kind: 'wake-requested'; wakeGeneration: number }>
  | Readonly<{ kind: 'not-stateless' }>
  | Readonly<{ kind: 'unknown' }>

type HostLifecycleView = {
  spec?: { lifecycle?: { stateless?: boolean } }
  status?: { lifecycle?: { state?: string } }
}

export async function executeHostWake(
  gateway: Pick<K8sGateway, 'getResource' | 'patchAnnotationMonotonic'>,
  hostRef: string
): Promise<HostWakeActionResult> {
  let host: HostLifecycleView
  try {
    host = (await gateway.getResource('hosts', hostRef, config.hostsNamespace)) as HostLifecycleView
  } catch (error) {
    if (error instanceof K8sNotFoundError) return { kind: 'unknown' }
    throw error
  }
  if (host.spec?.lifecycle?.stateless !== true) return { kind: 'not-stateless' }
  const state = host.status?.lifecycle?.state
  if (state === undefined || state === null || state === 'active') {
    return { kind: 'active', wakeGeneration: null }
  }
  const bump = await bumpWakeGeneration(hostRef, config.hostWakeCoalesceWindowMs)
  if (bump.shouldProject) {
    try {
      await gateway.patchAnnotationMonotonic(
        'hosts',
        hostRef,
        WAKE_REQUESTED_ANNOTATION,
        bump.generation,
        config.hostsNamespace
      )
    } catch (error) {
      if (error instanceof K8sNotFoundError) return { kind: 'unknown' }
      throw error
    }
  }
  return state === 'draining'
    ? { kind: 'active', wakeGeneration: bump.generation }
    : { kind: 'wake-requested', wakeGeneration: bump.generation }
}
