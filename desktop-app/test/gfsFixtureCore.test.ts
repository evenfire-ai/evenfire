import { describe, expect, it } from 'vitest'
import { assertFixtureName } from '../../tests/e2e/gfsFixtureCore'

describe('GFS E2E fixture names', () => {
  it('accepts a safe user-visible file extension', () => {
    expect(() => assertFixtureName('e2e-gfs-operator-root.md')).not.toThrow()
  })

  it('continues to reject paths and non-E2E names', () => {
    expect(() => assertFixtureName('../e2e-gfs-operator-root.md')).toThrow()
    expect(() => assertFixtureName('gfs-operator-root.md')).toThrow()
    expect(() => assertFixtureName('e2e-gfs-operator/root.md')).toThrow()
  })
})
