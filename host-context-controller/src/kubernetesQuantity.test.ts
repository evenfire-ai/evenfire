import { describe, expect, it } from 'vitest'
import { kubernetesQuantitiesEqual } from './kubernetesQuantity'

describe('kubernetesQuantitiesEqual', () => {
  it.each([
    ['1000m', '1'],
    ['0.025', '25m'],
    ['1000n', '1u'],
    ['1000u', '1m'],
    ['1k', '1000'],
    ['1M', '1000k'],
    ['1G', '1000M'],
    ['1T', '1000G'],
    ['1P', '1000T'],
    ['1E', '1000P'],
    ['1Ki', '1024'],
    ['1024Ki', '1Mi'],
    ['1024Mi', '1Gi'],
    ['1024Gi', '1Ti'],
    ['1024Ti', '1Pi'],
    ['1024Pi', '1Ei'],
    ['1.5Gi', '1536Mi'],
    ['100.035Ki', '102435.84'],
    ['0.025Ti', '27487790694.4'],
    ['1e3', '1k'],
    ['1E-3', '1m'],
    ['1.3E+6', '1300k'],
    ['025.000e-3', '+25m'],
    ['.001', '1m'],
    ['1.', '1'],
    ['1.G', '1G'],
    ['-1000m', '-1'],
    ['-1Gi', '-1024Mi'],
    ['-0', '+0.000Gi'],
    ['0e2147483647', '0n'],
  ])('recognizes %s and %s as equal', (left, right) => {
    expect(kubernetesQuantitiesEqual(left, right)).toBe(true)
    expect(kubernetesQuantitiesEqual(right, left)).toBe(true)
  })

  it.each([
    ['1', '1001m'],
    ['1k', '1Ki'],
    ['1M', '1Mi'],
    ['25m', '0.026'],
    ['1', '-1'],
    ['0', '1n'],
    ['9007199254740992', '9007199254740993'],
    ['1.000000001', '1'],
    ['1Gi', '1073741824.000000001'],
    ['12E', '9223372036854775807'],
  ])('distinguishes %s and %s', (left, right) => {
    expect(kubernetesQuantitiesEqual(left, right)).toBe(false)
    expect(kubernetesQuantitiesEqual(right, left)).toBe(false)
  })

  it.each([
    ['3.001n', '4n'],
    ['1.1E-9', '2n'],
    ['0.0000000001', '1n'],
    ['0.00000012345', '124n'],
    ['0.000000000001Ki', '2n'],
    ['-0.0000000001', '-1n'],
    ['-3.001n', '-4n'],
    ['1.0000000001', '1.000000001'],
    ['9.9999999991', '10'],
    ['-9.9999999991', '-10'],
    ['0.0000000010000', '1n'],
    ['0.0000000000000', '0'],
  ])('rounds %s away from zero at nano precision to %s', (left, right) => {
    expect(kubernetesQuantitiesEqual(left, right)).toBe(true)
  })

  it.each([
    ['9Ei', '9223372036854775807'],
    ['9223372036854775807Ki', '9223372036854775807'],
    ['-9Ei', '-9223372036854775807'],
    ['7.9999999999999999999Ei', '9223372036854775807'],
    ['12E', '12000000000000000000'],
    ['9223372036854775808', '9223372036854775808e0'],
  ])('applies format-specific maximum rules to %s and %s', (left, right) => {
    expect(kubernetesQuantitiesEqual(left, right)).toBe(true)
  })

  it.each([
    '',
    '+',
    '-',
    '.',
    '-.',
    'm',
    'Ki',
    '+Gi',
    '1.1.M',
    '1+1.0M',
    '0.1mi',
    '0.1am',
    'aoeu',
    '.5i',
    '1i',
    '-3.01e-',
    '1e',
    '1K',
    '1e1.5',
    ' 1',
    '1 ',
    '1\n',
    'NaN',
    'Infinity',
    '1e9223372036854775808',
    '1e-9223372036854775809',
  ])('rejects invalid quantities with a fixed error (%j)', value => {
    expect(() => kubernetesQuantitiesEqual(value, '1')).toThrowError(
      new Error('Invalid Kubernetes quantity')
    )
    expect(() => kubernetesQuantitiesEqual('1', value)).toThrowError(
      new Error('Invalid Kubernetes quantity')
    )
    expect(() => kubernetesQuantitiesEqual(value, value)).toThrowError(
      new Error('Invalid Kubernetes quantity')
    )
  })

  it('compares large positive exponents without expanding powers of ten', () => {
    expect(kubernetesQuantitiesEqual('1e1000000000', '10e999999999')).toBe(true)
    expect(kubernetesQuantitiesEqual('1e1000000000', '1e999999999')).toBe(false)
    expect(kubernetesQuantitiesEqual('1e2147483647', '10e2147483646')).toBe(true)
    expect(kubernetesQuantitiesEqual('1e-1000000000', '1n')).toBe(true)
    expect(kubernetesQuantitiesEqual('-1e-1000000000', '-1n')).toBe(true)
  })

  it('preserves the upstream int64-to-int32 exponent narrowing', () => {
    expect(kubernetesQuantitiesEqual('1e4294967296', '1')).toBe(true)
    expect(kubernetesQuantitiesEqual('1e4294967295', '0.1')).toBe(true)
    expect(kubernetesQuantitiesEqual('1e9223372036854775807', '0.1')).toBe(true)
    expect(kubernetesQuantitiesEqual('1e-9223372036854775808', '1')).toBe(true)
    expect(kubernetesQuantitiesEqual('1.0e-2147483648', '10e2147483647')).toBe(true)
  })

  it('preserves the slow parser nano scale wrapping at int32 boundaries', () => {
    expect(kubernetesQuantitiesEqual('1000000000000000000e2147483647', '1n')).toBe(true)
    expect(kubernetesQuantitiesEqual('1e-2147483648', '1n')).toBe(true)
  })

  it('rejects exponents outside int64 before creating an exponent BigInt', () => {
    const value = `1e${'9'.repeat(10000)}`
    expect(() => kubernetesQuantitiesEqual(value, '1')).toThrowError(
      new Error('Invalid Kubernetes quantity')
    )
  })

  it('handles long zero padding without expanding the exponent', () => {
    expect(kubernetesQuantitiesEqual(`1e+${'0'.repeat(10000)}1`, '10')).toBe(true)
    expect(kubernetesQuantitiesEqual(`1${'0'.repeat(10000)}e-10000`, '1')).toBe(true)
  })
})
