import {
  HISTORICAL_PUBLIC_KEY_FINGERPRINTS,
  JwtKeyMaterialError,
  MAX_PEM_MATERIAL_BYTES,
  isBannedPublicKeyPem,
  isBannedSigningKeyPem,
  normalizePem,
  parseSigningMaterial,
  parseVerifierMaterial,
  publicKeyPemFingerprint,
  type JwtFingerprintOptions,
  type JwtVerifierOptions,
  type SigningMaterial,
  type VerifierMaterial,
} from '@clerum/jwt-key-policy'

declare const configuredPem: string
declare const sourceLabel: string
const extraIdentities: Iterable<string> = new Set<string>()
const signingOptions: JwtFingerprintOptions = { fingerprints: extraIdentities }
const verifierOptions: JwtVerifierOptions = { origin: 'store', fingerprints: extraIdentities }
const signing: SigningMaterial = parseSigningMaterial(configuredPem, sourceLabel, signingOptions)
const verifier: VerifierMaterial = parseVerifierMaterial(configuredPem, sourceLabel, verifierOptions)
const canonicalPrivate: string = signing.privatePem
const canonicalPublic: string = verifier.publicPem
const identity: string = publicKeyPemFingerprint(canonicalPublic)
const normalized: string = normalizePem(configuredPem)
const signingDenied: boolean = isBannedSigningKeyPem(canonicalPrivate, extraIdentities)
const verifierDenied: boolean = isBannedPublicKeyPem(canonicalPublic, extraIdentities)
const maximum: 65536 = MAX_PEM_MATERIAL_BYTES
const failure = new JwtKeyMaterialError(sourceLabel, 'banned_identity')
const failureCode: 'ERR_JWT_KEY_INVALID' | 'ERR_JWT_KEY_BANNED' = failure.code

// @ts-expect-error The default policy is immutable to callers.
HISTORICAL_PUBLIC_KEY_FINGERPRINTS.push(identity)
// @ts-expect-error A public verifier result cannot expose private material.
verifier.privatePem
// @ts-expect-error Only the two defined origins are permitted.
parseVerifierMaterial(configuredPem, sourceLabel, { origin: 'unknown' })
// @ts-expect-error Error metadata is read-only to typed consumers.
failure.code = 'ERR_JWT_KEY_INVALID'

void [canonicalPrivate, canonicalPublic, identity, normalized, signingDenied, verifierDenied, maximum, failureCode]
