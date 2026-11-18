// Pure (no Electron imports) so the renderer can apply the exact rule main
// enforces in `app:openUrl` and only render links that main will open.

const MAILTO_PREFIX = /^mailto:/i
const MAILTO_MAX_LENGTH = 2048
// ASCII only: a bidi override, a zero-width character or a Cyrillic homoglyph
// would make the recipient shown in the link title and the mail client's "To"
// differ from the real one. The local part is RFC 5322 dot-atom minus `%`, `?`,
// `&` and `#`: without `%` no percent-decoding is needed, so an encoded `?`,
// CR/LF or header separator cannot hide inside a recipient the mail client
// would decode, and the other three would start a query or fragment.
// A single-label domain (`a@intranet`) is kept: it is a valid host, and ASCII
// labels cannot spoof another one.
const MAILTO_LOCAL_ATOM = "[A-Za-z0-9!$'*+/=^_`{|}~-]+"
const MAILTO_DOMAIN_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
const MAILTO_RECIPIENT = new RegExp(
  `^${MAILTO_LOCAL_ATOM}(?:\\.${MAILTO_LOCAL_ATOM})*` +
    `@${MAILTO_DOMAIN_LABEL}(?:\\.${MAILTO_DOMAIN_LABEL})*$`
)

/**
 * `mailto:` is reduced to its recipients: query fields such as `attach=` or
 * `body=` would let message text pre-fill (or attach local files to) a draft
 * in the system mail client.
 */
export function externalUrlToOpen(url: unknown): string {
  if (typeof url !== 'string') throw new Error('Only HTTP(S) or mailto: URLs are allowed')
  // Case-sensitive on purpose: the chat renderer canonicalises URLs before they reach main.
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  if (MAILTO_PREFIX.test(url)) {
    if (url.length > MAILTO_MAX_LENGTH) throw new Error('mailto: URL is too long')
    const end = url.search(/[?#]/)
    const addressPart = url.slice('mailto:'.length, end === -1 ? undefined : end).trim()
    if (!addressPart) throw new Error('mailto: URL has no recipient')
    const recipients = addressPart.split(',').map(recipient => recipient.trim())
    if (!recipients.every(recipient => MAILTO_RECIPIENT.test(recipient))) {
      throw new Error('mailto: URL has an invalid recipient')
    }
    return `mailto:${recipients.join(',')}`
  }
  throw new Error('Only HTTP(S) or mailto: URLs are allowed')
}
