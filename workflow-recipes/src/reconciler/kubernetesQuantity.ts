const BINARY_SUFFIXES = ['Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei']
const DECIMAL_EXPONENTS: Record<string, number> = {
  n: -9,
  u: -6,
  m: -3,
  '': 0,
  k: 3,
  M: 6,
  G: 9,
  T: 12,
  P: 15,
  E: 18,
}
const PLAIN_QUANTITY = /^([0-9]+)(?:\.([0-9]+))?(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/
/**
 * Longest value that is parsed. Far above any Kubernetes quantity (an int64 has
 * 19 digits); the reduction below costs about the square of the digit count, and
 * nothing at admission limits the length of a claim template size.
 */
export const MAX_QUANTITY_LENGTH = 64

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right]
  return left
}

/**
 * The exact amount of a Kubernetes quantity written as digits, an optional
 * fraction and an optional decimal or binary suffix (`1Gi`, `1024Mi`, `1.5Gi`,
 * `500M`, `107374182400m`), as a reduced fraction `<numerator>/<denominator>`:
 * two spellings of one amount give the same string. This is a subset of the
 * Kubernetes quantity grammar (a "plain" quantity). Every other value returns
 * undefined and the caller keeps comparing it as text: a sign, exponent notation,
 * a fraction without digits on one side (`.5Gi`, `1.`), all of which Kubernetes
 * accepts, and text that is not a quantity. A value longer than
 * {@link MAX_QUANTITY_LENGTH} characters also returns undefined, before it is
 * parsed, so it keeps the text comparison too.
 */
export function canonicalKubernetesQuantity(value: string): string | undefined {
  if (value.length > MAX_QUANTITY_LENGTH) return undefined
  const match = PLAIN_QUANTITY.exec(value)
  if (!match) return undefined
  const fraction = match[2] ?? ''
  const suffix = match[3] ?? ''
  let numerator = BigInt(match[1] + fraction)
  let denominator = 10n ** BigInt(fraction.length)
  const binaryIndex = BINARY_SUFFIXES.indexOf(suffix)
  if (binaryIndex >= 0) {
    numerator <<= BigInt((binaryIndex + 1) * 10)
  } else {
    const exponent = DECIMAL_EXPONENTS[suffix]
    if (exponent >= 0) numerator *= 10n ** BigInt(exponent)
    else denominator *= 10n ** BigInt(-exponent)
  }
  const divisor = greatestCommonDivisor(numerator, denominator)
  return `${numerator / divisor}/${denominator / divisor}`
}
