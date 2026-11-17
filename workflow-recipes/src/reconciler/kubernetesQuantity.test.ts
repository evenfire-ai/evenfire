import { describe, expect, it } from 'vitest'
import { canonicalKubernetesQuantity } from './kubernetesQuantity'

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
  ])('T-R3-L1-1: %s and %s are the same amount', (left, right) => {
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
  ])('T-R3-L1-1: %s and %s are different amounts', (left, right) => {
    const canonical = canonicalKubernetesQuantity(left)
    expect(canonical).toEqual(expect.stringMatching(/^[0-9]+\/[0-9]+$/))
    expect(canonicalKubernetesQuantity(right)).toEqual(expect.stringMatching(/^[0-9]+\/[0-9]+$/))
    expect(canonicalKubernetesQuantity(right)).not.toBe(canonical)
  })

  it.each(['', 'plenty', '1e3', '1E3', '+1Gi', '-1Gi', '1.Gi', '.5Gi', '1 Gi', '1gi', '1Gi '])(
    'T-R3-L1-1: %j is not a plain quantity and is left to a text comparison',
    value => {
      expect(canonicalKubernetesQuantity(value)).toBeUndefined()
    }
  )
})
