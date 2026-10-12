'use strict'

const { createHash, createPrivateKey, createPublicKey } = require('node:crypto')

// Public SPKI identities only. Never replace this policy through caller options.
const HISTORICAL_PUBLIC_KEY_FINGERPRINTS = Object.freeze([
  '4292d721765a93b0275f9f4ceb0a4667517fae00b5face8faa270513d610bb27',
  'f7dc08c248bf2b7724dead80dd96f9a5eeb49cf9920ba6fb46cf457a788d503e',
  '2d05f607d125e4bd3c157d5c6115bf63cb454c1e45cc5bcc8eed950771dcfd31',
])
const MAX_PEM_MATERIAL_BYTES = 65536
const PRIVATE_LABELS = new Set(['PRIVATE KEY', 'RSA PRIVATE KEY'])
const PUBLIC_LABELS = new Set(['PUBLIC KEY', 'RSA PUBLIC KEY', 'CERTIFICATE'])
const REASONS = Object.freeze({
  invalid_type: 'must be a PEM string with valid policy options',
  material_too_large: 'must not exceed 64 KiB of UTF-8 material',
  invalid_pem: 'must contain one complete, valid PEM object',
  multiple_pem_objects: 'must contain exactly one PEM object; mixed or concatenated objects are rejected',
  unsupported_pem_type: 'contains an unsupported PEM object type',
  encrypted_private_key: 'must not contain encrypted private material',
  wrong_key_role: 'contains PEM material that is not permitted for this key role',
  non_rsa_key: 'must be an RSA key for RS256; RSA-PSS and other key types are rejected',
  undersized_rsa_key: 'RSA modulus must be at least 2048 bits',
  banned_identity: 'must not use a historically committed dev JWT key or another denied identity',
})

function safeSource(source) {
  // The API accepts a diagnostic label, not a value, URL, or crypto exception.
  // Keep unsafe labels out of error messages as well as serialized metadata.
  return typeof source === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.:/ ()-]{0,159}$/.test(source) &&
    !/-----|(?:Bearer|Basic)\s/i.test(source)
    ? source
    : 'JWT key material'
}

class JwtKeyMaterialError extends Error {
  constructor(source, reason) {
    const safeReason = Object.hasOwn(REASONS, reason) ? reason : 'invalid_pem'
    const label = safeSource(source)
    super(`${label} ${REASONS[safeReason]}`)
    this.name = 'JwtKeyMaterialError'
    this.code = safeReason === 'banned_identity' ? 'ERR_JWT_KEY_BANNED' : 'ERR_JWT_KEY_INVALID'
    this.reason = safeReason
    this.source = label
  }
}

function reject(source, reason) {
  throw new JwtKeyMaterialError(source, reason)
}

function checkRaw(raw, source) {
  if (typeof raw !== 'string') reject(source, 'invalid_type')
  if (Buffer.byteLength(raw, 'utf8') > MAX_PEM_MATERIAL_BYTES) reject(source, 'material_too_large')
}

function normalizedValue(raw) {
  return raw.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\r\n?/g, '\n').trim()
}

function normalizePem(raw) {
  checkRaw(raw, 'JWT key material')
  return normalizedValue(raw)
}

function onePemObject(raw, source) {
  checkRaw(raw, source)
  const normalized = normalizedValue(raw)
  // Count every armor marker before parsing. OpenSSL otherwise selects a key
  // from a bundle and can prefer a certificate/public key over its private half.
  // Counting incomplete markers also prevents trailing truncated objects.
  const begins = normalized.match(/-----BEGIN\b/gi) || []
  const ends = normalized.match(/-----END\b/gi) || []
  if (begins.length > 1 || ends.length > 1) reject(source, 'multiple_pem_objects')
  if (begins.length !== 1 || ends.length !== 1) reject(source, 'invalid_pem')
  const begin = /-----BEGIN ([^\r\n-]+)-----/.exec(normalized)
  const end = /-----END ([^\r\n-]+)-----/.exec(normalized)
  if (!begin || !end || begin[1] !== end[1] || end.index <= begin.index) reject(source, 'invalid_pem')
  const label = begin[1]
  const body = normalized.slice(begin.index + begin[0].length, end.index)
  if (label === 'ENCRYPTED PRIVATE KEY' || /^(?:Proc-Type|DEK-Info):/mi.test(body)) {
    reject(source, 'encrypted_private_key')
  }
  if (!PRIVATE_LABELS.has(label) && !PUBLIC_LABELS.has(label)) reject(source, 'unsupported_pem_type')
  return { normalized, label }
}

function assertRsaStrength(key, source) {
  if (key.asymmetricKeyType !== 'rsa') reject(source, 'non_rsa_key')
  // Node >=24 exposes the actual parsed RSA modulus length for both key roles.
  // RFC 7518 section 3.3 requires 2048 bits for RS256, including verification.
  const bits = key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength
  if (!Number.isInteger(bits) || bits < 2048) reject(source, 'undersized_rsa_key')
}

function parsedPrivate(raw, source) {
  const object = onePemObject(raw, source)
  if (!PRIVATE_LABELS.has(object.label)) reject(source, 'wrong_key_role')
  let key
  try {
    key = createPrivateKey(object.normalized)
  } catch {
    reject(source, 'invalid_pem')
  }
  assertRsaStrength(key, source)
  return key
}

function parsedPublic(raw, source, origin) {
  const object = onePemObject(raw, source)
  const carriesPrivate = PRIVATE_LABELS.has(object.label)
  if (origin === 'store' && carriesPrivate) reject(source, 'wrong_key_role')
  let key
  try {
    // Legacy explicit verifier envs accepted private PEMs. Retain that input
    // contract, but export only its public identity and never retain raw PEM.
    key = carriesPrivate
      ? createPublicKey(createPrivateKey(object.normalized))
      : createPublicKey(object.normalized)
  } catch {
    reject(source, 'invalid_pem')
  }
  assertRsaStrength(key, source)
  return key
}

function fingerprint(key) {
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
}

function deniedIdentities(additional, source) {
  let extra
  try {
    if (additional !== undefined && (additional === null || typeof additional[Symbol.iterator] !== 'function')) {
      reject(source, 'invalid_type')
    }
    extra = additional === undefined ? [] : Array.from(additional)
  } catch {
    reject(source, 'invalid_type')
  }
  if (extra.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
    reject(source, 'invalid_type')
  }
  return new Set([...HISTORICAL_PUBLIC_KEY_FINGERPRINTS, ...extra])
}

function checkOptions(options, source) {
  if (options === null || (options !== undefined && typeof options !== 'object')) reject(source, 'invalid_type')
}

function assertAllowedIdentity(keyFingerprint, denied, source) {
  if (denied.has(keyFingerprint)) reject(source, 'banned_identity')
}

function parseSigningMaterial(raw, source, options) {
  checkOptions(options, source)
  const denied = deniedIdentities(options && options.fingerprints, source)
  const key = parsedPrivate(raw, source)
  // Derive every output from this exact private KeyObject, never from raw text.
  const publicKey = createPublicKey(key)
  const keyFingerprint = fingerprint(publicKey)
  assertAllowedIdentity(keyFingerprint, denied, source)
  return {
    privatePem: key.export({ type: 'pkcs8', format: 'pem' }).toString().trim(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString().trim(),
    fingerprint: keyFingerprint,
  }
}

function parseVerifierMaterial(raw, source, options) {
  checkOptions(options, source)
  const origin = options && options.origin !== undefined ? options.origin : 'environment'
  if (origin !== 'environment' && origin !== 'store') reject(source, 'invalid_type')
  const denied = deniedIdentities(options && options.fingerprints, source)
  const key = parsedPublic(raw, source, origin)
  const keyFingerprint = fingerprint(key)
  assertAllowedIdentity(keyFingerprint, denied, source)
  return { publicPem: key.export({ type: 'spki', format: 'pem' }).toString().trim(), fingerprint: keyFingerprint }
}

function publicKeyPemFingerprint(pem) {
  // Metadata must identify the historical public fixtures without accepting
  // their authority. Only the parsers apply the unconditional historical ban.
  return fingerprint(parsedPublic(pem, 'JWT public key fingerprint', 'environment'))
}

function isBannedSigningKeyPem(pem, additional) {
  try {
    const key = parsedPrivate(pem, 'JWT signing key identity')
    return deniedIdentities(additional, 'JWT signing key identity').has(fingerprint(createPublicKey(key)))
  } catch {
    return false
  }
}

function isBannedPublicKeyPem(pem, additional) {
  try {
    return deniedIdentities(additional, 'JWT public key identity').has(publicKeyPemFingerprint(pem))
  } catch {
    return false
  }
}

module.exports = {
  HISTORICAL_PUBLIC_KEY_FINGERPRINTS, MAX_PEM_MATERIAL_BYTES, JwtKeyMaterialError,
  normalizePem, parseSigningMaterial, parseVerifierMaterial, publicKeyPemFingerprint,
  isBannedSigningKeyPem, isBannedPublicKeyPem,
}
