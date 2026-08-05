import { describe, expect, it } from 'vitest'
import { shouldApplyRecipePrefill } from '../pluginWorkloadSdkPrefill'

describe('shouldApplyRecipePrefill', () => {
  it('applies the response for the current recipe when the operator has not edited recipients', () => {
    expect(shouldApplyRecipePrefill(2, 2, false)).toBe(true)
  })

  it('preserves an explicit recipient edit made while the request was pending', () => {
    expect(shouldApplyRecipePrefill(2, 2, true)).toBe(false)
  })

  it('drops a late response from a previously selected recipe', () => {
    expect(shouldApplyRecipePrefill(1, 2, false)).toBe(false)
  })
})
