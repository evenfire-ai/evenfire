'use strict'

/**
 * FileReferenceV1: the versioned, structured description of a file a turn
 * refers to — either an attachment delivered inline with the current message or
 * a Global Files resource. A reference describes a file; it never grants access
 * to it. Consumers re-authorize GFS references before reading them.
 */

const { FILE_CLASSES, MEDIA_TYPE_BY_CLASS, fileClassFamily } = require('./fileClassifier.cjs')

const FILE_REFERENCE_SCHEMA_VERSION = 1
const FILE_REFERENCE_NAME_MAX_CODE_POINTS = 255

const SCHEMA_VERSION_UNSUPPORTED = 'FILE_REFERENCE_SCHEMA_VERSION_UNSUPPORTED'
const INVALID = 'FILE_REFERENCE_INVALID'

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'id',
  'source',
  'name',
  'declaredMediaType',
  'detectedMediaType',
  'class',
  'detection',
  'mismatch',
  'byteLength',
  'digest',
  'textReadable',
  'reader',
  'modelImageInput',
])
const ATTACHMENT_SOURCE_KEYS = new Set(['kind', 'attachmentId', 'messageId'])
const GFS_SOURCE_KEYS = new Set(['kind', 'drive', 'resourceId', 'gfsUri', 'version'])
const DIGEST_KEYS = new Set(['algorithm', 'hex'])
const DETECTIONS = new Set(['magic', 'text_utf8', 'declared'])
const SHA256_HEX = /^[0-9a-f]{64}$/

function fail(message) {
  return { ok: false, code: INVALID, message }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unknownKey(value, allowed) {
  return Object.keys(value).find(key => !allowed.has(key))
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function nameProblem(name) {
  if (typeof name !== 'string' || name.length === 0) return 'name must be a non-empty string'
  if (name.normalize('NFC') !== name) return 'name must be NFC-normalized'
  if ([...name].length > FILE_REFERENCE_NAME_MAX_CODE_POINTS) {
    return `name must be at most ${FILE_REFERENCE_NAME_MAX_CODE_POINTS} code points`
  }
  if (name === '.' || name === '..') return 'name must not be a relative path segment'
  // Same character rule as the GFS controller's resource names: `/` and
  // control characters are rejected, a backslash is an ordinary character.
  // eslint-disable-next-line no-control-regex
  if (/[/\u0000-\u001f\u007f]/.test(name)) {
    return 'name must not contain "/" or control characters'
  }
  return null
}

/**
 * The id is derived from the source, never chosen by a producer, so two
 * references to the same bytes compare equal and a forged id is detectable.
 */
function deriveFileReferenceId(source, digest) {
  if (!isPlainObject(source)) throw new TypeError('source must be an object.')
  if (source.kind === 'attachment') {
    if (!isPlainObject(digest) || !SHA256_HEX.test(digest.hex ?? '')) {
      throw new TypeError('An attachment reference id requires a sha256 digest.')
    }
    return `att:${source.messageId}:${source.attachmentId}@sha256:${digest.hex}`
  }
  if (source.kind === 'gfs') {
    return `gfs:${source.drive}:${source.resourceId}@v${source.version}`
  }
  throw new TypeError(`Unknown file reference source kind: ${String(source.kind)}`)
}

function parseSource(source) {
  if (!isPlainObject(source)) return { problem: 'source must be an object' }
  if (source.kind === 'attachment') {
    const extra = unknownKey(source, ATTACHMENT_SOURCE_KEYS)
    if (extra) return { problem: `source has unknown field ${extra}` }
    if (!isNonEmptyString(source.attachmentId) || !isNonEmptyString(source.messageId)) {
      return { problem: 'attachment source requires attachmentId and messageId' }
    }
    return {
      value: { kind: 'attachment', attachmentId: source.attachmentId, messageId: source.messageId },
    }
  }
  if (source.kind === 'gfs') {
    const extra = unknownKey(source, GFS_SOURCE_KEYS)
    if (extra) return { problem: `source has unknown field ${extra}` }
    if (
      !isNonEmptyString(source.drive) ||
      !isNonEmptyString(source.resourceId) ||
      !isNonEmptyString(source.gfsUri)
    ) {
      return { problem: 'gfs source requires drive, resourceId and gfsUri' }
    }
    if (!Number.isSafeInteger(source.version) || source.version < 0) {
      return { problem: 'gfs source version must be a non-negative integer' }
    }
    return {
      value: {
        kind: 'gfs',
        drive: source.drive,
        resourceId: source.resourceId,
        gfsUri: source.gfsUri,
        version: source.version,
      },
    }
  }
  return { problem: 'source.kind must be attachment or gfs' }
}

function parseDigest(digest) {
  if (!isPlainObject(digest)) return { problem: 'digest must be an object' }
  const extra = unknownKey(digest, DIGEST_KEYS)
  if (extra) return { problem: `digest has unknown field ${extra}` }
  if (
    digest.algorithm !== 'sha256' ||
    typeof digest.hex !== 'string' ||
    !SHA256_HEX.test(digest.hex)
  ) {
    return { problem: 'digest must be sha256 with 64 lowercase hex characters' }
  }
  return { value: { algorithm: 'sha256', hex: digest.hex } }
}

function classificationProblem(input) {
  if (!FILE_CLASSES.includes(input.class)) return 'class is not a known file class'
  if (!DETECTIONS.has(input.detection)) return 'detection must be magic, text_utf8 or declared'
  if (typeof input.mismatch !== 'boolean') return 'mismatch must be a boolean'
  if (typeof input.textReadable !== 'boolean') return 'textReadable must be a boolean'
  const family = fileClassFamily(input.class)
  if (input.textReadable !== (family === 'text')) return 'textReadable contradicts class'
  if (input.reader !== (input.textReadable ? 'text' : 'none')) return 'reader contradicts class'
  const expectedImageInput = family === 'image' ? 'candidate' : 'unsupported'
  if (input.modelImageInput !== expectedImageInput) return 'modelImageInput contradicts class'
  if (input.detection === 'text_utf8' && family !== 'text') return 'detection contradicts class'
  const allowedMediaTypes =
    input.class === 'binary_unsupported'
      ? [MEDIA_TYPE_BY_CLASS.binary_unsupported, 'application/zip']
      : [MEDIA_TYPE_BY_CLASS[input.class]]
  if (!allowedMediaTypes.includes(input.detectedMediaType)) {
    return 'detectedMediaType contradicts class'
  }
  return null
}

/**
 * Parse an untrusted value as FileReferenceV1. A missing or different
 * schemaVersion is reported separately so callers can fail with an explicit
 * incompatibility instead of a generic validation error.
 */
function parseFileReferenceV1(input) {
  if (!isPlainObject(input)) return fail('file reference must be an object')
  if (input.schemaVersion !== FILE_REFERENCE_SCHEMA_VERSION) {
    return {
      ok: false,
      code: SCHEMA_VERSION_UNSUPPORTED,
      message: `unsupported file reference schemaVersion ${JSON.stringify(input.schemaVersion)}; expected ${FILE_REFERENCE_SCHEMA_VERSION}`,
    }
  }
  const extra = unknownKey(input, TOP_LEVEL_KEYS)
  if (extra) return fail(`file reference has unknown field ${extra}`)

  const source = parseSource(input.source)
  if (source.problem) return fail(source.problem)

  const problem = nameProblem(input.name)
  if (problem) return fail(problem)

  if (input.declaredMediaType !== null && !isNonEmptyString(input.declaredMediaType)) {
    return fail('declaredMediaType must be a non-empty string or null')
  }
  if (!isNonEmptyString(input.detectedMediaType)) return fail('detectedMediaType is required')
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
    return fail('byteLength must be a non-negative integer')
  }

  let digest
  if (input.digest !== undefined) {
    const parsedDigest = parseDigest(input.digest)
    if (parsedDigest.problem) return fail(parsedDigest.problem)
    digest = parsedDigest.value
  } else if (source.value.kind === 'attachment') {
    return fail('attachment references require a digest')
  }

  const classification = classificationProblem(input)
  if (classification) return fail(classification)

  const expectedId = deriveFileReferenceId(source.value, digest)
  if (input.id !== expectedId)
    return fail('id does not match the id derived from source and digest')

  const value = {
    schemaVersion: FILE_REFERENCE_SCHEMA_VERSION,
    id: expectedId,
    source: source.value,
    name: input.name,
    declaredMediaType: input.declaredMediaType,
    detectedMediaType: input.detectedMediaType,
    class: input.class,
    detection: input.detection,
    mismatch: input.mismatch,
    byteLength: input.byteLength,
    textReadable: input.textReadable,
    reader: input.reader,
    modelImageInput: input.modelImageInput,
  }
  if (digest) value.digest = digest
  return { ok: true, value }
}

function buildReference(source, fields, digest) {
  const name = typeof fields.name === 'string' ? fields.name.normalize('NFC') : fields.name
  const classification = fields.classification ?? {}
  const candidate = {
    schemaVersion: FILE_REFERENCE_SCHEMA_VERSION,
    source,
    name,
    declaredMediaType: fields.declaredMediaType ?? null,
    detectedMediaType: classification.detectedMediaType,
    class: classification.class,
    detection: classification.detection,
    mismatch: classification.mismatch,
    byteLength: fields.byteLength,
    textReadable: classification.textReadable,
    reader: classification.reader,
    modelImageInput: classification.modelImageInput,
  }
  if (digest) candidate.digest = digest
  const sourceCheck = parseSource(source)
  if (sourceCheck.problem) return fail(sourceCheck.problem)
  if (source.kind === 'attachment' && !(digest && SHA256_HEX.test(digest.hex ?? ''))) {
    return fail('attachment references require a sha256 digest')
  }
  candidate.id = deriveFileReferenceId(sourceCheck.value, digest)
  return parseFileReferenceV1(candidate)
}

/**
 * Build a reference for an attachment delivered inline with the current
 * message. `classification` is the output of classifyBytes over the whole file.
 */
function buildAttachmentFileReference(fields) {
  return buildReference(
    { kind: 'attachment', attachmentId: fields.attachmentId, messageId: fields.messageId },
    fields,
    { algorithm: 'sha256', hex: fields.digestHex }
  )
}

/** Build a reference for a Global Files resource at an exact version. */
function buildGfsFileReference(fields) {
  return buildReference(
    {
      kind: 'gfs',
      drive: fields.drive,
      resourceId: fields.resourceId,
      gfsUri: fields.gfsUri,
      version: fields.version,
    },
    fields,
    fields.digestHex === undefined ? undefined : { algorithm: 'sha256', hex: fields.digestHex }
  )
}

module.exports = {
  FILE_REFERENCE_SCHEMA_VERSION,
  buildAttachmentFileReference,
  buildGfsFileReference,
  deriveFileReferenceId,
  parseFileReferenceV1,
}
