import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPositiveIntegerEnv } from '../../../src/workflow/runtimeEnv'

describe('runtime env parsing', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('returns the default when the env var is unset or empty', () => {
    expect(readPositiveIntegerEnv('WORKFLOW_RECIPE_TEST_LIMIT', 10)).toBe(10)

    vi.stubEnv('WORKFLOW_RECIPE_TEST_LIMIT', '')
    expect(readPositiveIntegerEnv('WORKFLOW_RECIPE_TEST_LIMIT', 10)).toBe(10)
  })

  it('returns a positive integer env value', () => {
    vi.stubEnv('WORKFLOW_RECIPE_TEST_LIMIT', '42')

    expect(readPositiveIntegerEnv('WORKFLOW_RECIPE_TEST_LIMIT', 10)).toBe(42)
  })

  it('rejects zero, negative, and non-integer values', () => {
    vi.stubEnv('WORKFLOW_RECIPE_TEST_LIMIT', '0')
    expect(() => readPositiveIntegerEnv('WORKFLOW_RECIPE_TEST_LIMIT', 10)).toThrow(
      'WORKFLOW_RECIPE_TEST_LIMIT must be a positive integer'
    )

    vi.stubEnv('WORKFLOW_RECIPE_TEST_LIMIT', '-1')
    expect(() => readPositiveIntegerEnv('WORKFLOW_RECIPE_TEST_LIMIT', 10)).toThrow(
      'WORKFLOW_RECIPE_TEST_LIMIT must be a positive integer'
    )

    vi.stubEnv('WORKFLOW_RECIPE_TEST_LIMIT', '1.5')
    expect(() => readPositiveIntegerEnv('WORKFLOW_RECIPE_TEST_LIMIT', 10)).toThrow(
      'WORKFLOW_RECIPE_TEST_LIMIT must be a positive integer'
    )

    vi.stubEnv('WORKFLOW_RECIPE_TEST_LIMIT', 'abc')
    expect(() => readPositiveIntegerEnv('WORKFLOW_RECIPE_TEST_LIMIT', 10)).toThrow(
      'WORKFLOW_RECIPE_TEST_LIMIT must be a positive integer'
    )
  })
})
