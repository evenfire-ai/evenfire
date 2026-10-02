import {
  HISTORICAL_PUBLIC_KEY_FINGERPRINTS,
  isBannedPublicKeyPem,
  isBannedSigningKeyPem,
  parseSigningMaterial,
  parseVerifierMaterial,
  publicKeyPemFingerprint,
} from '@clerum/jwt-key-policy'

export { isBannedPublicKeyPem, isBannedSigningKeyPem, publicKeyPemFingerprint }

// Preserve the legacy ReadonlySet API without exposing a mutable policy Set.
export const BANNED_DEV_JWT_PUBLIC_KEY_FINGERPRINTS: ReadonlySet<string> = Object.freeze({
  size: HISTORICAL_PUBLIC_KEY_FINGERPRINTS.length,
  has: (value: string) => HISTORICAL_PUBLIC_KEY_FINGERPRINTS.includes(value),
  entries: () =>
    HISTORICAL_PUBLIC_KEY_FINGERPRINTS.map(value => [value, value] as [string, string]).values(),
  keys: () => HISTORICAL_PUBLIC_KEY_FINGERPRINTS.values(),
  values: () => HISTORICAL_PUBLIC_KEY_FINGERPRINTS.values(),
  [Symbol.iterator]: () => HISTORICAL_PUBLIC_KEY_FINGERPRINTS.values(),
  forEach(
    callback: (value: string, key: string, set: ReadonlySet<string>) => void,
    thisArg?: unknown
  ) {
    for (const value of HISTORICAL_PUBLIC_KEY_FINGERPRINTS) {
      callback.call(thisArg, value, value, BANNED_DEV_JWT_PUBLIC_KEY_FINGERPRINTS)
    }
  },
})

/** Compatibility entry point; policy and canonical identity belong to the package. */
export function validateRsaPrivateKeyPem(privateKeyPem: string, envName: string): string {
  return parseSigningMaterial(privateKeyPem, envName).privatePem
}

export function assertNoBannedJwtKeys(
  input: {
    rpcPrivateKey: string
    sessionPrivateKey: string
    adminPrivateKey: string
    voucherPrivateKey?: string
    rpcPublicKey: string
    rpcPublicKeyEnvSet: boolean
  },
  fingerprints?: Iterable<string>
): void {
  const options = { fingerprints }
  const rpc = parseSigningMaterial(input.rpcPrivateKey, 'CONTROL_API_RPC_JWT_PRIVATE_KEY', options)
  parseSigningMaterial(input.sessionPrivateKey, 'CONTROL_API_SESSION_JWT_PRIVATE_KEY', options)
  parseSigningMaterial(input.adminPrivateKey, 'CONTROL_API_ADMIN_JWT_PRIVATE_KEY', options)
  if (input.voucherPrivateKey) {
    parseSigningMaterial(
      input.voucherPrivateKey,
      'CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY',
      options
    )
  }
  const verifier = parseVerifierMaterial(
    input.rpcPublicKey,
    'effective RPC JWT verifier public key (CONTROL_API_RPC_JWT_PUBLIC_KEY)',
    options
  )
  if (input.rpcPublicKeyEnvSet && verifier.fingerprint !== rpc.fingerprint) {
    throw new Error(
      'CONTROL_API_RPC_JWT_PUBLIC_KEY must correspond to CONTROL_API_RPC_JWT_PRIVATE_KEY'
    )
  }
}
