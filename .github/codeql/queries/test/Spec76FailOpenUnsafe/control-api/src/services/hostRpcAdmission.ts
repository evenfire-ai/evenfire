import { config } from '../config.js'
import { admitStrictFixedWindow } from './strictFixedWindowAdmission.js'

export const HOST_RPC_ADMISSION_BUCKET_PREFIX = 'host-rpc-admission:'
const HOST_RPC_ADMISSION_OPERATIONS = new Set([
  'host.wake',
  'task.manage',
  'task.read',
  'session.read',
  'session.manage',
  'model.read',
  'model.select',
  'host.activity.read',
  'host.activity.read_all',
  'host.status.read',
  'host.health.read',
])

export function requiresHostRpcAdmission(operationId: string): boolean {
  return HOST_RPC_ADMISSION_OPERATIONS.has(operationId)
}

export function hostRpcAdmissionBucketKey(verifiedSubject: string): string {
  return `${HOST_RPC_ADMISSION_BUCKET_PREFIX}${verifiedSubject}`
}

export async function admitHostRpc(verifiedSubject: string) {
  if (!verifiedSubject) return { status: 'unavailable' }
  return admitStrictFixedWindow(
    hostRpcAdmissionBucketKey(verifiedSubject),
    config.hostRpcAdmissionRlPerMin
  )
}

export function respondHostRpcAdmissionFailure(res: any, admission: any): void {
  res.status(admission.status === 'unavailable' ? 503 : 429).json({ error: 'admission_failed' })
}
