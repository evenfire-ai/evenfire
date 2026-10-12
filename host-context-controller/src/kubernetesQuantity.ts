const decimalSuffixes = ['n', 'u', 'm', '', 'k', 'M', 'G', 'T', 'P', 'E']
const binarySuffixes = ['Ki', 'Mi', 'Gi', 'Ti', 'Pi', 'Ei']
const maximumBinaryQuantity = '9223372036854775807'

function invalidQuantity(): never {
  throw new Error('Invalid Kubernetes quantity')
}

function decimalExponent(suffix: string): number {
  const negative = suffix[1] === '-'
  const digits = suffix.slice(1).replace(/^[+-]/, '').replace(/^0+/, '') || '0'
  const maximum = negative ? '9223372036854775808' : '9223372036854775807'
  if (digits.length > maximum.length || (digits.length === maximum.length && digits > maximum)) {
    invalidQuantity()
  }
  // Apimachinery parses a signed int64 exponent, then narrows it to int32.
  return Number(BigInt.asIntN(32, BigInt(`${negative ? '-' : ''}${digits}`)))
}

function normalizedQuantity(value: string): string {
  const match =
    /^([+-]?)([0-9]*)(?:\.([0-9]*))?(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei|[eE][+-]?[0-9]+)?$/.exec(
      value
    )
  // Require a digit as the Quantity grammar does, rather than accepting the
  // Go scanner's undocumented bare-sign, bare-dot, or bare-suffix zero aliases.
  if (!match || match[0] !== value || !(match[2] || match[3])) {
    invalidQuantity()
  }

  const numerator = match[2].replace(/^0+/, '') || '0'
  const fraction = match[3] || ''
  const suffix = match[4] || ''
  const binaryIndex = binarySuffixes.indexOf(suffix)
  const decimalIndex = decimalSuffixes.indexOf(suffix)
  let digits = `${numerator}${fraction}`.replace(/^0+/, '') || '0'
  let exponent = -fraction.length

  if (binaryIndex >= 0) {
    // BinarySI has only six fixed exponents, so this shift cannot grow with an
    // exponent supplied by the caller.
    digits = (BigInt(digits) << BigInt((binaryIndex + 1) * 10)).toString()
  } else {
    const suffixExponent = decimalIndex >= 0 ? (decimalIndex - 3) * 3 : decimalExponent(suffix)
    exponent = (suffixExponent - fraction.length) | 0
    if (numerator.length + fraction.length > 18 || exponent < -9) {
      // The slow decimal parser rounds to nano using int32 scale arithmetic.
      // Preserve its scale wrapping without constructing its power of ten.
      exponent = ((exponent + 9) | 0) - 9
    }
  }

  if (digits === '0') return '0'

  if (exponent < -9) {
    const keptDigits = digits.length + exponent + 9
    if (keptDigits <= 0) {
      digits = '1'
    } else {
      const remainder = /[1-9]/.test(digits.slice(keptDigits))
      digits = (BigInt(digits.slice(0, keptDigits)) + (remainder ? 1n : 0n)).toString()
    }
    exponent = -9
  }

  const withoutTrailingZeroes = digits.replace(/0+$/, '')
  exponent += digits.length - withoutTrailingZeroes.length
  digits = withoutTrailingZeroes

  // ParseQuantity caps only BinarySI; DecimalSI and exponent quantities can
  // exceed int64. After nano rounding, this comparison needs at most 28 digits.
  if (
    binaryIndex >= 0 &&
    (digits.length + exponent > maximumBinaryQuantity.length ||
      (digits.length + exponent === maximumBinaryQuantity.length &&
        digits.padEnd(maximumBinaryQuantity.length, '0') > maximumBinaryQuantity))
  ) {
    digits = maximumBinaryQuantity
    exponent = 0
  }

  // Keep powers of ten as an integer exponent, including very large values.
  return `${match[1] === '-' ? '-' : ''}${digits}e${exponent}`
}

/** Compare numeric Quantity values using apimachinery v0.34.0 precision rules. */
export function kubernetesQuantitiesEqual(left: string, right: string): boolean {
  return normalizedQuantity(left) === normalizedQuantity(right)
}
