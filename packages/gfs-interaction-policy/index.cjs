'use strict'

/**
 * Pure, browser-safe GFS interaction policy shared by Control UI and Desktop.
 * This module owns product decisions only: transports and presentation remain
 * inside each application.
 */

const GFS_RESOURCE_NAME_MAX_LENGTH = 255
const GFS_RESOURCE_NAME_HASH_LENGTH = 12
const GFS_RESOURCE_EXTENSION_MAX_LENGTH = 48
const GFS_UPLOAD_NAME_RETRY_LIMIT = 100
const GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE = 'Could not create a unique GFS resource name.'

function extensionOf(name) {
  const lastDot = name.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === name.length - 1) return ''
  const extension = name.slice(lastDot)
  return extension.length <= GFS_RESOURCE_EXTENSION_MAX_LENGTH ? extension : ''
}

function truncatedBaseForSuffix(base, suffix) {
  const maxBaseLength = GFS_RESOURCE_NAME_MAX_LENGTH - suffix.length
  if (maxBaseLength <= 0) throw new Error(GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE)
  const truncatedBase = base.slice(0, maxBaseLength).replace(/[\s._-]+$/g, '')
  return truncatedBase || base.slice(0, maxBaseLength)
}

async function sha256Hex(value) {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi || !cryptoApi.subtle) {
    throw new Error('Web Crypto is required to normalize long GFS resource names.')
  }
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function normalizeGfsResourceName(name) {
  const normalized = name.normalize('NFC')
  // eslint-disable-next-line no-control-regex
  if (normalized === '.' || normalized === '..' || /[\/\\\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('File and folder names cannot contain path separators or control characters.')
  }
  if (normalized.length <= GFS_RESOURCE_NAME_MAX_LENGTH) return normalized

  const extension = extensionOf(normalized)
  const base = extension ? normalized.slice(0, -extension.length) : normalized
  const hash = (await sha256Hex(normalized)).slice(0, GFS_RESOURCE_NAME_HASH_LENGTH)
  const suffix = `-${hash}${extension}`
  return `${truncatedBaseForSuffix(base, suffix)}${suffix}`
}

/**
 * Precondition: name has already passed through normalizeGfsResourceName.
 */
function nextAvailableGfsResourceName(name, occupiedNames) {
  const normalized = name.normalize('NFC')
  const occupied = new Set(Array.from(occupiedNames, value => value.normalize('NFC')))
  if (!occupied.has(normalized)) return normalized

  const extension = extensionOf(normalized)
  const base = extension ? normalized.slice(0, -extension.length) : normalized
  for (let index = 1; index <= 10_000; index += 1) {
    const suffix = ` (${index})${extension}`
    const candidate = `${truncatedBaseForSuffix(base, suffix)}${suffix}`
    if (!occupied.has(candidate)) return candidate
  }

  throw new Error(GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE)
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function is409(value) {
  return value === 409 || value === '409'
}

function isGfsNameConflict(error) {
  const details = isObject(error) ? error : null
  const structuredStatus = details?.status ?? details?.response?.status
  // A structured non-409 response is authoritative. Do not reinterpret a 4xx
  // permission or validation failure as a collision because its text happens
  // to contain a compatibility keyword.
  if (structuredStatus !== undefined) return is409(structuredStatus)

  const code = typeof details?.code === 'string' ? details.code : ''
  if (/^(?:conflict|already_exists|duplicate|name_conflict|resource_exists)$/i.test(code)) {
    return true
  }

  const parts = [
    error instanceof Error ? error.message : error,
    details?.message,
    details?.bodyText,
  ].filter(value => value !== undefined && value !== null)
  const message = parts.map(String).join(' ')
  return (
    /\b409\b[\s\S]*\bconflict\b/i.test(message) ||
    /\bconflict\b[\s\S]*\b409\b/i.test(message) ||
    /\b(?:already exists|duplicate|name[_ ]?conflict|resource[_ ]?exists)\b/i.test(message)
  )
}

function gfsUploadNameRetryDecision(error, options) {
  const attempt = options?.attempt
  const retryLimit = options?.retryLimit ?? GFS_UPLOAD_NAME_RETRY_LIMIT
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error('GFS upload name retry attempt must be a non-negative integer.')
  }
  if (!Number.isSafeInteger(retryLimit) || retryLimit < 1) {
    throw new Error('GFS upload name retry limit must be a positive integer.')
  }
  if (!isGfsNameConflict(error) || options?.resuming === true) return 'terminal'
  return attempt + 1 < retryLimit ? 'retry' : 'exhausted'
}

function createGfsUploadNameReservationBook() {
  const byParent = new Map()

  function reservationCounts(parentKey) {
    let counts = byParent.get(parentKey)
    if (!counts) {
      counts = new Map()
      byParent.set(parentKey, counts)
    }
    return counts
  }

  function acquire(parentKey, name) {
    const counts = reservationCounts(parentKey)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  function release(parentKey, names) {
    const counts = byParent.get(parentKey)
    if (!counts) return
    for (const name of names) {
      const count = counts.get(name) ?? 0
      if (count <= 1) counts.delete(name)
      else counts.set(name, count - 1)
    }
    if (counts.size === 0) byParent.delete(parentKey)
  }

  return {
    begin(parentKey, normalizedName, occupiedNames) {
      const attempts = []
      let settled = false
      return {
        reserveNext(options = {}) {
          if (settled) throw new Error('GFS upload name reservation is already settled.')
          const reserved = byParent.get(parentKey)?.keys() ?? []
          const name = options.exact
            ? normalizedName.normalize('NFC')
            : nextAvailableGfsResourceName(normalizedName, [...occupiedNames, ...reserved])
          acquire(parentKey, name)
          attempts.push(name)
          return name
        },
        markConflict(name) {
          occupiedNames.add(name)
        },
        markSuccess(name) {
          occupiedNames.add(name)
        },
        release() {
          if (settled) return
          settled = true
          release(parentKey, attempts)
        },
      }
    },
    reservedNames(parentKey) {
      return [...(byParent.get(parentKey)?.keys() ?? [])]
    },
  }
}

module.exports = {
  GFS_RESOURCE_NAME_MAX_LENGTH,
  GFS_UPLOAD_NAME_EXHAUSTED_MESSAGE,
  GFS_UPLOAD_NAME_RETRY_LIMIT,
  createGfsUploadNameReservationBook,
  gfsUploadNameRetryDecision,
  isGfsNameConflict,
  nextAvailableGfsResourceName,
  normalizeGfsResourceName,
}
