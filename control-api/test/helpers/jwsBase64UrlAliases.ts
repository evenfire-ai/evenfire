const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export type CanonicalJwsSegmentName = 'header' | 'payload' | 'signature'

export type JwsAliasKind = 'unused-bits' | 'padding' | 'standard-alphabet' | 'ignored-character'

export type JwsAliasVariant = Readonly<{
  segment: CanonicalJwsSegmentName
  kind: JwsAliasKind
  alias: string
  token: string
}>

type SegmentAlias = Readonly<{ alias: string; kind: JwsAliasKind }>

const SEGMENT_NAMES: readonly CanonicalJwsSegmentName[] = ['header', 'payload', 'signature']

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

/**
 * Return the other textual encodings that Node's lenient base64url decoder
 * maps to the same bytes by varying only the unused low bits of the final
 * character.
 */
function tailBitAliases(segment: string): SegmentAlias[] {
  const remainder = segment.length % 4
  if (remainder !== 2 && remainder !== 3) return []
  const lastIndex = BASE64URL_ALPHABET.indexOf(segment.slice(-1))
  if (lastIndex < 0) {
    throw new Error('cannot derive a base64url alias from a non-alphabet segment')
  }
  // A final group of two characters carries two significant bits and four
  // unused bits; a final group of three carries four significant bits and two
  // unused bits. Varying only the unused bits keeps the decoded bytes equal.
  const unusedBits = remainder === 2 ? 4 : 2
  const highBits = lastIndex & ~((1 << unusedBits) - 1)
  return Array.from({ length: (1 << unusedBits) - 1 }, (_, offset) => ({
    alias: segment.slice(0, -1) + BASE64URL_ALPHABET[highBits | (offset + 1)],
    kind: 'unused-bits' as const,
  }))
}

export function canonicalBase64UrlAliases(segment: string): SegmentAlias[] {
  const remainder = segment.length % 4
  const found = new Map<string, JwsAliasKind>()
  found.set(`${segment.slice(0, 1)}\n${segment.slice(1)}`, 'ignored-character')
  for (const alias of tailBitAliases(segment)) found.set(alias.alias, alias.kind)
  // Padding is only a textual alias when the final group is incomplete.
  if (remainder === 2) found.set(`${segment}==`, 'padding')
  if (remainder === 3) found.set(`${segment}=`, 'padding')
  if (segment.includes('-')) found.set(segment.replace(/-/g, '+'), 'standard-alphabet')
  if (segment.includes('_')) found.set(segment.replace(/_/g, '/'), 'standard-alphabet')
  found.delete(segment)
  const decoded = decodeBase64Url(segment)
  for (const alias of found.keys()) {
    if (!decodeBase64Url(alias).equals(decoded)) {
      throw new Error('generated alias does not decode to the presented segment bytes')
    }
  }
  return [...found].map(([alias, kind]) => ({ alias, kind }))
}

export function jwsAliasVariants(token: string): JwsAliasVariant[] {
  const segments = token.split('.')
  if (segments.length !== SEGMENT_NAMES.length) {
    throw new Error('expected a JWS with exactly three segments')
  }
  return SEGMENT_NAMES.flatMap((segment, index) =>
    canonicalBase64UrlAliases(segments[index]!).map(alias => {
      const parts = [...segments]
      parts[index] = alias.alias
      return { segment, kind: alias.kind, alias: alias.alias, token: parts.join('.') }
    })
  )
}
