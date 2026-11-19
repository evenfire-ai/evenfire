const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i

/**
 * Lower-cased RFC 3986 scheme of `href`, or null when it has none. Shared by
 * the chat href policy and the chat click handler so a link is routed by the
 * same scheme it was rendered for.
 */
export function urlScheme(href: string): string | null {
  return URL_SCHEME.exec(href)?.[1]?.toLowerCase() ?? null
}

/**
 * Schemes a chat link may hand to the system browser or mail client. The href
 * policy renders a link only for these and the click handler opens only these,
 * so a link never renders for a target the click would ignore. Main checks every
 * target again against its own list in `app:openUrl`, which is the trust boundary.
 */
export const EXTERNAL_LINK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto'])
