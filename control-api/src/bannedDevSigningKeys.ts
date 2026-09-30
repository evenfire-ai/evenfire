import { type KeyObject, createHash, createPrivateKey, createPublicKey } from 'node:crypto'

/**
 * SHA-256 fingerprints over the public SPKI DER halves of the three RSA keys
 * that were once committed to this repository as dev JWT signing defaults.
 * The private keys were removed; these fingerprints permanently ban them from
 * every signing and verifying slot. Fingerprints of public keys are not
 * secrets and carry no signing material.
 */
export const BANNED_DEV_JWT_PUBLIC_KEY_FINGERPRINTS: ReadonlySet<string> = new Set([
  // Committed dev RPC JWT key (removed from src/config.ts).
  '4292d721765a93b0275f9f4ceb0a4667517fae00b5face8faa270513d610bb27',
  // Committed dev session JWT key (removed from src/config.ts).
  'f7dc08c248bf2b7724dead80dd96f9a5eeb49cf9920ba6fb46cf457a788d503e',
  // Committed dev admin JWT key (removed from src/config.ts).
  '2d05f607d125e4bd3c157d5c6115bf63cb454c1e45cc5bcc8eed950771dcfd31',
])

function spkiDerFingerprint(key: KeyObject | string): string {
  const keyObject = typeof key === 'string' ? createPublicKey(key) : key
  const der = keyObject.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex')
}

export function publicKeyPemFingerprint(publicKeyPem: string): string {
  return spkiDerFingerprint(publicKeyPem)
}

export function isBannedPublicKeyPem(
  publicKeyPem: string,
  fingerprints: ReadonlySet<string> = BANNED_DEV_JWT_PUBLIC_KEY_FINGERPRINTS
): boolean {
  try {
    return fingerprints.has(publicKeyPemFingerprint(publicKeyPem))
  } catch {
    return false
  }
}

export function isBannedSigningKeyPem(
  privateKeyPem: string,
  fingerprints: ReadonlySet<string> = BANNED_DEV_JWT_PUBLIC_KEY_FINGERPRINTS
): boolean {
  try {
    return fingerprints.has(spkiDerFingerprint(createPublicKey(privateKeyPem)))
  } catch {
    return false
  }
}

/**
 * Strict validation for configured signing keys: must parse as a PEM private
 * key, be RSA, and have at least a 2048-bit modulus so RS256 is safe to use.
 * Parse failures produce an error naming the environment variable; the PEM
 * itself is never included in the message.
 */
export function validateRsaPrivateKeyPem(privateKeyPem: string, envName: string): string {
  let key: KeyObject
  try {
    key = createPrivateKey(privateKeyPem)
  } catch {
    throw new Error(
      `${envName} must be a PEM-encoded RSA private key (PKCS#8 or PKCS#1); parsing failed. ` +
        'Public-key PEMs, truncated bodies, and escaped line breaks are rejected.'
    )
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(
      `${envName} must be an RSA key for RS256 signing (got '${key.asymmetricKeyType}')`
    )
  }
  const jwk = key.export({ format: 'jwk' }) as { n?: string }
  if (typeof jwk.n !== 'string') {
    throw new Error(`${envName} could not be inspected as a JWK; refusing to use it for RS256`)
  }
  const modulusBytes = Buffer.from(jwk.n, 'base64url')
  let firstNonZero = 0
  while (firstNonZero < modulusBytes.length && modulusBytes[firstNonZero] === 0) firstNonZero++
  const modulusBits =
    modulusBytes.length === firstNonZero
      ? 0
      : (modulusBytes.length - firstNonZero - 1) * 8 +
        Math.ceil(Math.log2(modulusBytes[firstNonZero] + 1))
  if (modulusBits < 2048) {
    throw new Error(`${envName} RSA modulus must be at least 2048 bits (got ${modulusBits})`)
  }
  return privateKeyPem
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
  fingerprints: ReadonlySet<string> = BANNED_DEV_JWT_PUBLIC_KEY_FINGERPRINTS
): void {
  const slots: Array<[envName: string, pem: string]> = [
    ['CONTROL_API_RPC_JWT_PRIVATE_KEY', input.rpcPrivateKey],
    ['CONTROL_API_SESSION_JWT_PRIVATE_KEY', input.sessionPrivateKey],
    ['CONTROL_API_ADMIN_JWT_PRIVATE_KEY', input.adminPrivateKey],
  ]
  if (input.voucherPrivateKey) {
    slots.push(['CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY', input.voucherPrivateKey])
  }
  for (const [envName, pem] of slots) {
    if (isBannedSigningKeyPem(pem, fingerprints)) {
      throw new Error(
        `[SECURITY] Startup rejected: ${envName} resolves to a historically committed dev JWT key. ` +
          'Replace it with a deployment-specific RSA key.'
      )
    }
  }
  if (isBannedPublicKeyPem(input.rpcPublicKey, fingerprints)) {
    throw new Error(
      '[SECURITY] Startup rejected: the effective RPC JWT verifier public key is a historically ' +
        'committed dev JWT key. Set CONTROL_API_RPC_JWT_PUBLIC_KEY to the public half of the ' +
        'configured private key.'
    )
  }
  if (input.rpcPublicKeyEnvSet) {
    const derived = createPublicKey(input.rpcPrivateKey)
      .export({ type: 'spki', format: 'pem' })
      .toString()
      .trim()
    if (derived !== input.rpcPublicKey.trim()) {
      throw new Error(
        'CONTROL_API_RPC_JWT_PUBLIC_KEY must correspond to CONTROL_API_RPC_JWT_PRIVATE_KEY'
      )
    }
  }
}
