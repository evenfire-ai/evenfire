/** Decode UTF-8 Markdown without replacement characters or implicit BOM removal. */
export function decodeMarkdownSource(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

/** Encode the editor's Unicode source as UTF-8, preserving an explicit leading BOM. */
export function encodeMarkdownSource(source: string): Uint8Array {
  return new TextEncoder().encode(source)
}
