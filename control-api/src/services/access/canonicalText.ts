/** Exact lexicographic ordering of unsigned UTF-8 bytes used by access identities. */
export function compareCanonicalUtf8Text(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}
