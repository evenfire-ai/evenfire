/**
 * Byte-wise value classes of the egress-proxy template contract
 * (docs/crds/mcpserver.md "Value classes").
 *
 * The image check (nginx-egress-proxy/egress-proxy-template-check), the HCC
 * preflight (reconciler.ts, EgressProxyValuesValid) and the operator script
 * (scripts/ops/egress-proxy-value-preflight.sh) must return the same verdict
 * for the same bytes. All three read the shared corpus in
 * nginx-egress-proxy/egress-proxy-value-corpus.tsv:
 * src/__tests__/egressProxyValueClass.test.ts compares this module with the
 * expected column, and the image harness compares the awk program with the same
 * column, so a class change on one side without the other fails a test.
 *
 * The inputs are bytes, never strings: a Secret value is
 * Buffer.from(secretData[key], 'base64') and a CRD literal is
 * Buffer.from(value, 'utf8'). No TextDecoder and no code-point logic belongs
 * here. The quoted class is defined on bytes so that an invalid UTF-8 byte, a
 * lone continuation byte or an overlong encoding gets the same verdict in the
 * image (BusyBox index()), in this module and in the operator script, in every
 * locale.
 */

/**
 * The query-position character set of the contract, the expanded form of the
 * awk class `[-A-Za-z0-9._~!'()*,=:@/?]`. `%` is absent on purpose: a complete
 * %XX escape is skipped before the remaining bytes are judged, and a `%` that
 * does not start one is not a query character.
 */
export const QUERY_VALUE_CHARACTERS =
  "-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~!'()*,=:@/?"

/** Byte membership of QUERY_VALUE_CHARACTERS; 1 = allowed. */
const QUERY_VALUE_BYTES = (() => {
  const allowed = new Uint8Array(256)
  for (const character of QUERY_VALUE_CHARACTERS) allowed[character.charCodeAt(0)] = 1
  return allowed
})()

const PERCENT = 0x25
const HEX_UPPER_A = 0x41
const HEX_UPPER_F = 0x46
const HEX_LOWER_A = 0x61
const HEX_LOWER_F = 0x66
const DIGIT_0 = 0x30
const DIGIT_9 = 0x39

function hexadecimalValue(byte: number): number {
  if (byte >= DIGIT_0 && byte <= DIGIT_9) return byte - DIGIT_0
  if (byte >= HEX_UPPER_A && byte <= HEX_UPPER_F) return byte - HEX_UPPER_A + 10
  if (byte >= HEX_LOWER_A && byte <= HEX_LOWER_F) return byte - HEX_LOWER_A + 10
  return -1
}

/**
 * Query position: an unquoted argument after an unescaped `?`, the value of a
 * `${NAME}` placeholder in `proxy_pass`.
 *
 * One left-to-right pass removes non-overlapping complete `%XX` escapes, with
 * the `gsub()` semantics the image check pins: text created by a removal is not
 * examined again, so `a%%4141` leaves `a%41` (rejected) and `a%2%41` leaves
 * `a%2` (rejected). Every remaining byte must be a query character. A byte
 * >= 0x80 is rejected: it is not allowed unencoded in a URI.
 */
export function isQueryValueAllowed(bytes: Uint8Array): boolean {
  let index = 0
  while (index < bytes.length) {
    const byte = bytes[index]
    if (byte === PERCENT) {
      if (
        index + 2 < bytes.length &&
        hexadecimalValue(bytes[index + 1]) >= 0 &&
        hexadecimalValue(bytes[index + 2]) >= 0
      ) {
        index += 3
        continue
      }
      return false
    }
    if (QUERY_VALUE_BYTES[byte] !== 1) return false
    index += 1
  }
  return true
}

/**
 * Quoted position: the resolved value of an `authHeaders[].valueTemplate`
 * reference, rendered inside `proxy_set_header <header> "..."`.
 *
 * Rejected bytes are exactly those that end the NGINX string, start a
 * variable, or end or split the header line: 0x00-0x1F, 0x7F, `"`, `$` and `\`.
 * Every other byte is accepted, including every byte >= 0x80 (RFC 9110
 * obs-text), whether or not it forms valid UTF-8. 0x00 cannot be part of an
 * environment variable value (a C string ends there), so the image never sees
 * it; this module rejects it because a Secret value can hold it, which is the
 * documented extra strictness of the preflight.
 */
export function isQuotedValueAllowed(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte <= 0x1f || byte === 0x7f || byte === 0x22 || byte === 0x24 || byte === 0x5c) {
      return false
    }
  }
  return true
}
