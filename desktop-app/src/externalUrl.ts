// Pure (no Electron imports) so the renderer can apply the exact rule main
// enforces in `app:openUrl` and only render links that main will open.

const MAILTO_PREFIX = /^mailto:/i
const MAILTO_MAX_LENGTH = 2048
// No `%` means no percent-decoding is needed: an encoded `?`, CR/LF or header
// separator cannot hide inside a recipient that the mail client would decode.
const MAILTO_RECIPIENT = /^[^\s\x00-\x1f\x7f%?&#<>"\\;:@,]+@[A-Za-z0-9.-]+$/

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
