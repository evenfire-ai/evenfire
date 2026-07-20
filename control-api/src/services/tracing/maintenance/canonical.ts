import { createHash } from 'node:crypto'
import { stableStringify } from '../../../utils/stableStringify.js'

export function canonicalJson(value: unknown): string {
  return stableStringify(value)
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
