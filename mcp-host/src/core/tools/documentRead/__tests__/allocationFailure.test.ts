import { describe, expect, it } from 'vitest'
import { isAllocationError } from '../documentMemory'

function coded(code: string): Error {
  return Object.assign(new Error('allocation failed'), { code })
}

function wrap(cause: Error, depth: number): Error {
  let error = cause
  for (let index = 0; index < depth; index += 1) {
    error = new Error('wrapped allocation failure', { cause: error })
  }
  return error
}

describe('allocation failure classification', () => {
  it('recognizes the V8 fatal allocation code and refuses another code', () => {
    expect(isAllocationError(coded('ERR_MEMORY_ALLOCATION_FAILED'))).toBe(true)
    // Liveness: the same Error with another code is not an allocation failure.
    expect(isAllocationError(coded('ERR_SOMETHING_ELSE'))).toBe(false)
    expect(isAllocationError(new Error('boom'))).toBe(false)
  })

  it('recognizes only the closed RangeError messages', () => {
    expect(isAllocationError(new RangeError('Array buffer allocation failed'))).toBe(true)
    expect(isAllocationError(new RangeError('Failed to allocate memory'))).toBe(true)
    // Liveness: the same class with another message is not on the list.
    expect(isAllocationError(new RangeError('Invalid array length'))).toBe(false)
  })

  it('recognizes the pdf.js UnknownErrorException allocation messages', () => {
    const pdfjs = (message: string) =>
      Object.assign(new Error(message), { name: 'UnknownErrorException' })
    expect(isAllocationError(pdfjs('allocation failed'))).toBe(true)
    expect(isAllocationError(pdfjs('Failed to allocate memory'))).toBe(true)
    // Liveness: the same wrapper name with a parse message is not an allocation failure.
    expect(isAllocationError(pdfjs('Invalid PDF structure'))).toBe(false)
  })

  it('follows a wrapped cause up to three levels and stops there', () => {
    const allocation = new RangeError('Array buffer allocation failed')
    expect(isAllocationError(wrap(allocation, 1))).toBe(true)
    expect(isAllocationError(wrap(allocation, 3))).toBe(true)
    // Liveness: the same nesting one level deeper is outside the closed list.
    expect(isAllocationError(wrap(allocation, 4))).toBe(false)
    // Liveness: the same wrapper with an unrelated cause is not an allocation failure.
    expect(isAllocationError(wrap(new Error('parse failed'), 1))).toBe(false)
  })

  it('does not classify non-Error values by their shape', () => {
    expect(isAllocationError(undefined)).toBe(false)
    expect(isAllocationError('ERR_MEMORY_ALLOCATION_FAILED')).toBe(false)
    expect(isAllocationError({ code: 'ERR_MEMORY_ALLOCATION_FAILED' })).toBe(false)
    // Liveness: the same property on an Error is recognized.
    expect(isAllocationError(coded('ERR_MEMORY_ALLOCATION_FAILED'))).toBe(true)
  })
})
