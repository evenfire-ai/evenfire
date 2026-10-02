// This file is checked with --noEmit; no store operation is executed.
import {
  DevKeyStoreError,
  loadOrCreateDevSigningMaterial,
  readDevVerifierMaterial,
  resolveDevKeyStoreDir,
  type DevJwtSlot,
  type DevSigningMaterial,
  type DevVerifierMaterial,
} from '@clerum/jwt-key-policy/dev-store'

const slot: DevJwtSlot = 'rpc'
const directory: string = resolveDevKeyStoreDir('/compile-only-service', '')
const signing: DevSigningMaterial = loadOrCreateDevSigningMaterial(slot, directory)
const verifying: DevVerifierMaterial = readDevVerifierMaterial(slot, directory)
const acceptedFingerprint: string = signing.fingerprint
const acceptedPublic: string = verifying.publicPem
const storeFailure = new DevKeyStoreError('compile-only-source', 'missing_material')
const storeCode: 'ERR_JWT_DEV_STORE' = storeFailure.code

// @ts-expect-error The closed slot cannot become a path supplied by a caller.
loadOrCreateDevSigningMaterial('../rpc', directory)
// @ts-expect-error Canonical material fields are readonly for consumers.
signing.privatePem = ''
// @ts-expect-error Canonical verifier identity is readonly for consumers.
verifying.fingerprint = ''
// @ts-expect-error Error reasons are a closed safe contract.
new DevKeyStoreError('compile-only-source', 'unknown_reason')

void [acceptedFingerprint, acceptedPublic, storeCode]
