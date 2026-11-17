import { describe, expect, it } from 'vitest'
import { MAX_QUANTITY_LENGTH, canonicalKubernetesQuantity } from './kubernetesQuantity'

describe('canonicalKubernetesQuantity', () => {
  it.each([
    ['1024Mi', '1Gi'],
    ['1.5Gi', '1536Mi'],
    ['0.5Gi', '512Mi'],
    ['2048Mi', '2Gi'],
    ['1024Ki', '1Mi'],
    ['1024Gi', '1Ti'],
    ['1Ki', '1024'],
    ['1G', '1000M'],
    ['1M', '1000k'],
    ['1k', '1000'],
    ['1000m', '1'],
    ['0.025', '25m'],
    ['1000u', '1m'],
    ['1000n', '1u'],
    ['0.1Gi', '107374182400m'],
    ['100.035Ki', '102435.84'],
    ['010Gi', '10Gi'],
    ['0', '0Gi'],
  ])('T-1530-1: %s and %s are the same amount (issue #1530)', (left, right) => {
    const canonical = canonicalKubernetesQuantity(left)
    expect(canonical).toEqual(expect.stringMatching(/^[0-9]+\/[0-9]+$/))
    expect(canonicalKubernetesQuantity(right)).toBe(canonical)
  })

  it.each([
    ['1Gi', '2Gi'],
    ['1G', '1Gi'],
    ['1M', '1Mi'],
    ['1k', '1Ki'],
    ['1', '1001m'],
    ['1Gi', '1073741824.000000001'],
    ['9007199254740992', '9007199254740993'],
  ])('T-1530-1: %s and %s are different amounts (issue #1530)', (left, right) => {
    const canonical = canonicalKubernetesQuantity(left)
    expect(canonical).toEqual(expect.stringMatching(/^[0-9]+\/[0-9]+$/))
    expect(canonicalKubernetesQuantity(right)).toEqual(expect.stringMatching(/^[0-9]+\/[0-9]+$/))
    expect(canonicalKubernetesQuantity(right)).not.toBe(canonical)
  })

  it.each(['', 'plenty', '1e3', '1E3', '+1Gi', '-1Gi', '1.Gi', '.5Gi', '1 Gi', '1gi', '1Gi '])(
    'T-1530-1: %j is not a plain quantity and is left to a text comparison (issue #1530)',
    value => {
      expect(canonicalKubernetesQuantity(value)).toBeUndefined()
    }
  )

  it('T-1530-LEN: a plain quantity longer than MAX_QUANTITY_LENGTH is not parsed and is left to a text comparison (issue #1530)', () => {
    const atBound = `1.${'0'.repeat(MAX_QUANTITY_LENGTH - 4)}Gi`
    const overBound = `1.${'0'.repeat(MAX_QUANTITY_LENGTH - 3)}Gi`
    expect(MAX_QUANTITY_LENGTH).toBe(64)
    expect(atBound).toHaveLength(64)
    expect(overBound).toHaveLength(65)
    // Witness: the same amount written within the bound is parsed, as 1Gi.
    expect(canonicalKubernetesQuantity(atBound)).toEqual(expect.stringMatching(/^[0-9]+\/[0-9]+$/))
    expect(canonicalKubernetesQuantity(atBound)).toBe(canonicalKubernetesQuantity('1Gi'))
    expect(canonicalKubernetesQuantity(overBound)).toBeUndefined()
  })
})
