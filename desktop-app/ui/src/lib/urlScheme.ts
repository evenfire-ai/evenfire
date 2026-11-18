const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i

/**
 * Lower-cased RFC 3986 scheme of `href`, or null when it has none. Shared by
 * the chat href policy and the chat click handler so a link is routed by the
 * same scheme it was rendered for.
 */
export function urlScheme(href: string): string | null {
  return URL_SCHEME.exec(href)?.[1]?.toLowerCase() ?? null
}
