import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../../config.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import {
  CATALOG_FAMILIES,
  type CatalogFamily,
  type CatalogKey,
  type ProducerContinuation,
} from './catalogContracts.js'

export const ACCESS_CATALOG_CONTRACT_VERSION = '2' as const
export const ACCESS_CATALOG_SORT = 'environment-type-logical-v1' as const

export type AccessCatalogCursorV3 = Readonly<{
  v: 3
  contractVersion: typeof ACCESS_CATALOG_CONTRACT_VERSION
  authorizationRevision: string
  sourceStateRevision: string
  filterHash: string
  sort: typeof ACCESS_CATALOG_SORT
  lastCanonicalKey: CatalogKey
  producers: Readonly<Record<CatalogFamily, ProducerContinuation>>
  validUntil: string | null
}>

export class AccessCatalogCursorError extends Error {
  constructor(readonly code: 'invalid_cursor' | 'stale_cursor') {
    super(`Access catalog cursor rejected: ${code}`)
    this.name = 'AccessCatalogCursorError'
  }
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null
}

function parseKey(value: unknown): CatalogKey {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !boundedString(value[0], 512) ||
    !CATALOG_FAMILIES.includes(value[1] as CatalogFamily) ||
    !boundedString(value[2], 1_024)
  ) {
    throw new AccessCatalogCursorError('invalid_cursor')
  }
  return Object.freeze([String(value[0]), value[1] as CatalogFamily, String(value[2])])
}

function parseContinuation(value: unknown): ProducerContinuation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccessCatalogCursorError('invalid_cursor')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.exhausted !== 'boolean') {
    throw new AccessCatalogCursorError('invalid_cursor')
  }
  if (candidate.opaqueState !== undefined && boundedString(candidate.opaqueState, 2_048) === null) {
    throw new AccessCatalogCursorError('invalid_cursor')
  }
  return Object.freeze({
    afterKey: candidate.afterKey === null ? null : parseKey(candidate.afterKey),
    exhausted: candidate.exhausted,
    ...(candidate.opaqueState ? { opaqueState: String(candidate.opaqueState) } : {}),
  })
}

function payloadFromUnknown(value: unknown): AccessCatalogCursorV3 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccessCatalogCursorError('invalid_cursor')
  }
  const input = value as Record<string, unknown>
  if (
    input.v !== 3 ||
    input.contractVersion !== ACCESS_CATALOG_CONTRACT_VERSION ||
    input.sort !== ACCESS_CATALOG_SORT
  ) {
    throw new AccessCatalogCursorError('invalid_cursor')
  }
  const authorizationRevision = boundedString(input.authorizationRevision, 256)
  const sourceStateRevision = boundedString(input.sourceStateRevision, 256)
  const filterHash = boundedString(input.filterHash, 256)
  if (!authorizationRevision || !sourceStateRevision || !filterHash) {
    throw new AccessCatalogCursorError('invalid_cursor')
  }
  const lastCanonicalKey = parseKey(input.lastCanonicalKey)
  if (!input.producers || typeof input.producers !== 'object' || Array.isArray(input.producers)) {
    throw new AccessCatalogCursorError('invalid_cursor')
  }
  const rawProducers = input.producers as Record<string, unknown>
  if (
    Object.keys(rawProducers).length !== CATALOG_FAMILIES.length ||
    Object.keys(rawProducers).some(key => !CATALOG_FAMILIES.includes(key as CatalogFamily))
  ) {
    throw new AccessCatalogCursorError('invalid_cursor')
  }
  const producers = Object.fromEntries(
    CATALOG_FAMILIES.map(family => {
      const continuation = parseContinuation(rawProducers[family])
      if (
        continuation.afterKey &&
        (continuation.afterKey[0] !== lastCanonicalKey[0] || continuation.afterKey[1] !== family)
      ) {
        throw new AccessCatalogCursorError('invalid_cursor')
      }
      return [family, continuation]
    })
  ) as Record<CatalogFamily, ProducerContinuation>
  let validUntil: string | null = null
  if (input.validUntil !== null) {
    const raw = boundedString(input.validUntil, 64)
    if (!raw || Number.isNaN(new Date(raw).getTime())) {
      throw new AccessCatalogCursorError('invalid_cursor')
    }
    validUntil = new Date(raw).toISOString()
  }
  return Object.freeze({
    v: 3,
    contractVersion: ACCESS_CATALOG_CONTRACT_VERSION,
    authorizationRevision,
    sourceStateRevision,
    filterHash,
    sort: ACCESS_CATALOG_SORT,
    lastCanonicalKey,
    producers: Object.freeze(producers),
    validUntil,
  })
}

function signature(encodedPayload: string): Buffer {
  return createHmac('sha256', config.sessionJwtPrivateKey).update(encodedPayload).digest()
}

export function catalogFilterHash(families: readonly CatalogFamily[]): string {
  return `cf1_${createHash('sha256')
    .update(JSON.stringify({ families: [...families], sort: ACCESS_CATALOG_SORT }))
    .digest('base64url')}`
}

export function encodeAccessCatalogCursor(
  payload: AccessCatalogCursorV3,
  budget: AccessExecutionBudget
): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const cursor = `c3.${encoded}.${signature(encoded).toString('base64url')}`
  budget.assertCursorBytes(Buffer.byteLength(cursor, 'utf8'))
  return cursor
}

export function decodeAccessCatalogCursor(
  cursor: string,
  budget: AccessExecutionBudget
): AccessCatalogCursorV3 {
  budget.assertCursorBytes(Buffer.byteLength(cursor, 'utf8'))
  const parts = cursor.split('.')
  if (parts.length !== 3 || parts[0] !== 'c3' || !parts[1] || !parts[2]) {
    throw new AccessCatalogCursorError('invalid_cursor')
  }
  const expected = signature(parts[1])
  let supplied: Buffer
  try {
    supplied = Buffer.from(parts[2], 'base64url')
  } catch {
    throw new AccessCatalogCursorError('invalid_cursor')
  }
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new AccessCatalogCursorError('invalid_cursor')
  }
  try {
    return payloadFromUnknown(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')))
  } catch (error) {
    if (error instanceof AccessCatalogCursorError) throw error
    throw new AccessCatalogCursorError('invalid_cursor')
  }
}

export function assertAccessCatalogCursorCurrent(
  cursor: AccessCatalogCursorV3,
  expected: {
    authorizationRevision: string
    sourceStateRevision: string
    filterHash: string
    now?: Date
  }
): void {
  if (
    cursor.authorizationRevision !== expected.authorizationRevision ||
    cursor.sourceStateRevision !== expected.sourceStateRevision ||
    cursor.filterHash !== expected.filterHash
  ) {
    throw new AccessCatalogCursorError('stale_cursor')
  }
  if (
    cursor.validUntil &&
    new Date(cursor.validUntil).getTime() <= (expected.now ?? new Date()).getTime()
  ) {
    throw new AccessCatalogCursorError('stale_cursor')
  }
}
