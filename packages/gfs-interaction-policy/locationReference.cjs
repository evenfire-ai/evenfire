'use strict'

/**
 * LocationReferenceV1: the versioned description of a Global Files folder a
 * turn is about, as the place to create, save or list files. Unlike a
 * FileReferenceV1 it names no version or size: a folder changes every time
 * something is created inside it, often by the agent itself. A reference
 * describes a folder; it never grants access to it. Consumers re-authorize it
 * before using it.
 */

const { normalizeGfsRid, resourceNameProblem } = require('./fileReference.cjs')

const LOCATION_REFERENCE_SCHEMA_VERSION = 1
// One destination per message keeps "use this folder unless another place is
// named" unambiguous for the model.
const LOCATION_REFERENCE_MAX_COUNT = 1

const SCHEMA_VERSION_UNSUPPORTED = 'FILE_REFERENCE_SCHEMA_VERSION_UNSUPPORTED'
const INVALID = 'FILE_REFERENCE_INVALID'

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'id', 'name', 'source'])
const SOURCE_KEYS = new Set(['kind', 'drive', 'resourceId', 'gfsUri'])

function fail(message) {
  return { ok: false, code: INVALID, message }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unknownKey(value, allowed) {
  return Object.keys(value).find(key => !allowed.has(key))
}

function echo(value) {
  const text = String(value)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/** Derived from the source like a FileReferenceV1 id, so a forged id is detectable. */
function deriveLocationReferenceId(source) {
  if (!isPlainObject(source)) throw new TypeError('source must be an object.')
  if (source.kind !== 'gfs') {
    throw new TypeError(`Unknown location reference source kind: ${String(source.kind)}`)
  }
  return `gfs-folder:${source.drive}:${source.resourceId}`
}

function parseSource(source) {
  if (!isPlainObject(source)) return { problem: 'source must be an object' }
  if (source.kind !== 'gfs') return { problem: 'source.kind must be gfs' }
  const extra = unknownKey(source, SOURCE_KEYS)
  if (extra) return { problem: `source has unknown field ${echo(extra)}` }
  if (
    !isNonEmptyString(source.drive) ||
    !isNonEmptyString(source.resourceId) ||
    !isNonEmptyString(source.gfsUri)
  ) {
    return { problem: 'gfs source requires drive, resourceId and gfsUri' }
  }
  const rid = normalizeGfsRid(source.resourceId)
  if (!rid) return { problem: 'gfs source resourceId must be 32 hex digits' }
  if (source.gfsUri !== `gfs://${source.drive}/${rid}`) {
    return { problem: 'gfs source gfsUri must name its drive and resourceId' }
  }
  return {
    value: {
      kind: 'gfs',
      drive: source.drive,
      resourceId: source.resourceId,
      gfsUri: source.gfsUri,
    },
  }
}

/**
 * Parse an untrusted value as LocationReferenceV1. It shares the FileReference
 * error codes, so a consumer refuses both kinds of reference the same way.
 */
function parseLocationReferenceV1(input) {
  if (!isPlainObject(input)) return fail('location reference must be an object')
  if (input.schemaVersion !== LOCATION_REFERENCE_SCHEMA_VERSION) {
    return {
      ok: false,
      code: SCHEMA_VERSION_UNSUPPORTED,
      message: `unsupported location reference schemaVersion ${echo(JSON.stringify(input.schemaVersion))}; expected ${LOCATION_REFERENCE_SCHEMA_VERSION}`,
    }
  }
  const extra = unknownKey(input, TOP_LEVEL_KEYS)
  if (extra) return fail(`location reference has unknown field ${echo(extra)}`)

  const source = parseSource(input.source)
  if (source.problem) return fail(source.problem)

  const problem = resourceNameProblem(input.name)
  if (problem) return fail(problem)

  const expectedId = deriveLocationReferenceId(source.value)
  if (input.id !== expectedId) return fail('id does not match the id derived from source')

  return {
    ok: true,
    value: {
      schemaVersion: LOCATION_REFERENCE_SCHEMA_VERSION,
      id: expectedId,
      name: input.name,
      source: source.value,
    },
  }
}

/** Build a reference to a Global Files folder; the name is normalized to NFC. */
function buildGfsLocationReference(fields) {
  const source = {
    kind: 'gfs',
    drive: fields.drive,
    resourceId: fields.resourceId,
    gfsUri: fields.gfsUri,
  }
  const sourceCheck = parseSource(source)
  if (sourceCheck.problem) return fail(sourceCheck.problem)
  return parseLocationReferenceV1({
    schemaVersion: LOCATION_REFERENCE_SCHEMA_VERSION,
    id: deriveLocationReferenceId(sourceCheck.value),
    name: typeof fields.name === 'string' ? fields.name.normalize('NFC') : fields.name,
    source,
  })
}

module.exports = {
  LOCATION_REFERENCE_MAX_COUNT,
  LOCATION_REFERENCE_SCHEMA_VERSION,
  buildGfsLocationReference,
  deriveLocationReferenceId,
  parseLocationReferenceV1,
}
