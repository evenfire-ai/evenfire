import { config } from '../config.js'
import { checkAndIncrementStrict } from './rateLimiterService.js'
import {
  type StrictFixedWindowAdmission,
  admitStrictFixedWindow,
  respondStrictFixedWindowFailure,
} from './strictFixedWindowAdmission.js'

export const HOST_RPC_ADMISSION_BUCKET_PREFIX = 'host-rpc-admission:'

/** Closed checkpoint operation set approved by Task 106 Spec 65. */
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

/** One durable, subject-wide budget shared by legacy Host routes and v2 checkpoints. */
export async function admitHostRpc(
  verifiedSubject: string,
  check: typeof checkAndIncrementStrict = checkAndIncrementStrict
): Promise<StrictFixedWindowAdmission> {
  if (!verifiedSubject) return { status: 'unavailable' }
  return admitStrictFixedWindow(
    hostRpcAdmissionBucketKey(verifiedSubject),
    config.hostRpcAdmissionRlPerMin,
    check
  )
}

export function respondHostRpcAdmissionFailure(
  res: import('express').Response,
  admission: Exclude<StrictFixedWindowAdmission, { status: 'allowed' }>
): void {
  respondStrictFixedWindowFailure(
    res,
    admission,
    'host_rpc_admission_unavailable',
    config.hostRpcAdmissionRlPerMin
  )
}
