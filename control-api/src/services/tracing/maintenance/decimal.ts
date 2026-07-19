const SCALE_DIGITS = 9
const SCALE = 1_000_000_000n
const MAX_ABSOLUTE_UNITS = 10n ** 24n - 1n
const DECIMAL_PATTERN = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?$/

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('decimal denominator must be positive')
  const negative = numerator < 0n
  const absolute = negative ? -numerator : numerator
  const quotient = absolute / denominator
  const remainder = absolute % denominator
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient
  return negative ? -rounded : rounded
}

/** Exact fixed-point decimal matching the governed cost NUMERIC(*, 9) columns. */
export class Decimal9 {
  static readonly zero = new Decimal9(0n)

  private constructor(readonly units: bigint) {
    if (units < -MAX_ABSOLUTE_UNITS || units > MAX_ABSOLUTE_UNITS) {
      throw new Error('decimal(24,9) overflow')
    }
  }

  static parse(value: string): Decimal9 {
    const match = DECIMAL_PATTERN.exec(value)
    if (!match) throw new Error(`invalid decimal(9): ${value}`)
    const fraction = (match[3] ?? '').padEnd(SCALE_DIGITS, '0')
    const absolute = BigInt(match[2]) * SCALE + BigInt(fraction || '0')
    return new Decimal9(match[1] === '-' ? -absolute : absolute)
  }

  static fromUnits(units: bigint): Decimal9 {
    return new Decimal9(units)
  }

  static fromRatio(numerator: bigint, denominator: bigint): Decimal9 {
    return new Decimal9(divideRounded(numerator * SCALE, denominator))
  }

  add(other: Decimal9): Decimal9 {
    return new Decimal9(this.units + other.units)
  }

  subtract(other: Decimal9): Decimal9 {
    return new Decimal9(this.units - other.units)
  }

  multiply(other: Decimal9): Decimal9 {
    return new Decimal9(divideRounded(this.units * other.units, SCALE))
  }

  isNegative(): boolean {
    return this.units < 0n
  }

  isPositive(): boolean {
    return this.units > 0n
  }

  isZero(): boolean {
    return this.units === 0n
  }

  compare(other: Decimal9): -1 | 0 | 1 {
    if (this.units < other.units) return -1
    if (this.units > other.units) return 1
    return 0
  }

  toString(): string {
    const negative = this.units < 0n
    const absolute = negative ? -this.units : this.units
    const integer = absolute / SCALE
    const fraction = (absolute % SCALE).toString().padStart(SCALE_DIGITS, '0')
    return `${negative ? '-' : ''}${integer}.${fraction}`
  }
}

export function sumDecimals(values: readonly Decimal9[]): Decimal9 {
  return values.reduce((sum, value) => sum.add(value), Decimal9.zero)
}
