import { dirname } from 'node:path'
import {
  type DevJwtSlot,
  type DevSigningMaterial,
  loadOrCreateDevSigningMaterial,
  resolveDevKeyStoreDir,
} from '@clerum/jwt-key-policy/dev-store'
import { rootLogger } from './observability/logger.js'

export type { DevJwtSlot }

// In CJS this is <service>/src or <service>/dist; test transforms use the
// service working directory. The package never infers a caller's service root.
const SERVICE_ROOT = typeof __dirname === 'string' && __dirname ? dirname(__dirname) : process.cwd()

export function defaultDevSigningKeyStoreDir(): string {
  return resolveDevKeyStoreDir(SERVICE_ROOT, process.env.EVENFIRE_DEV_KEY_STORE)
}

let warnedOnce = false

export function loadOrCreateDevJwtSigningMaterial(
  slot: DevJwtSlot,
  storeDir?: string
): DevSigningMaterial {
  const absoluteStore = storeDir === undefined ? defaultDevSigningKeyStoreDir() : storeDir
  const material = loadOrCreateDevSigningMaterial(slot, absoluteStore)
  if (!warnedOnce) {
    warnedOnce = true
    rootLogger.warn(
      { event: 'dev_jwt_signing_keys_active', storeDir: absoluteStore },
      'Local dev JWT signing keys are active; never use this store for production'
    )
  }
  return material
}

/** Legacy consumer API, backed by the shared canonical store contract. */
export function loadOrGenerateDevJwtPrivateKey(slot: DevJwtSlot, storeDir?: string): string {
  return loadOrCreateDevJwtSigningMaterial(slot, storeDir).privatePem
}
