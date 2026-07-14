import { describe, expect, it } from 'vitest'
import { makeHostSubjectId } from '../src/gfs/hostSubject.js'
import { parseSubject } from '../src/routes/gfs/grants.js'

describe('GFS host subjects', () => {
  it('accepts only canonical first- and third-party host subjects', () => {
    expect(parseSubject({ type: 'host', id: '1st:mcp-host/standalone' })).toEqual({
      type: 'host',
      id: '1st:mcp-host/standalone',
    })
    expect(parseSubject({ type: 'host', id: '3rd:sandbox-recipes/daily-report' })).toEqual({
      type: 'host',
      id: '3rd:sandbox-recipes/daily-report',
    })
  })

  it('rejects free-form or malformed host subjects before grants are persisted', () => {
    for (const id of [
      'mcp-host/standalone',
      '1st:Upper/standalone',
      '3rd:sandbox-recipes/../x',
      '3rd:sandbox-recipes/',
      '4th:sandbox-recipes/recipe',
    ]) {
      expect(() => parseSubject({ type: 'host', id })).toThrow(/subject_invalid/)
    }
  })

  it('normalizes provisioner host subject ids through one helper', () => {
    expect(makeHostSubjectId('1st', 'mcp-host', 'standalone')).toBe('1st:mcp-host/standalone')
    expect(makeHostSubjectId('3rd', 'sandbox-recipes', 'daily-report')).toBe(
      '3rd:sandbox-recipes/daily-report'
    )
    expect(makeHostSubjectId('3rd', 'sandbox-recipes', '../daily-report')).toBeNull()
  })
})
