import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { makeHostSubjectId } from '../src/gfs/hostSubject.js'
import { parseSubject } from '../src/routes/gfs/grants.js'

type HostSubjectVector = {
  label: string
  namespace: string
  name: string
  displayText: string
  expectedSubjectId: string | null
  expectedSubject: string | null
}

const vectors = JSON.parse(
  readFileSync(
    new URL('../../tests/contracts/gfs-host-subject-vectors.json', import.meta.url),
    'utf8'
  )
) as HostSubjectVector[]

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

  it.each(vectors)('derives the canonical durable identity: $label', vector => {
    const actual = makeHostSubjectId('1st', vector.namespace, vector.name)

    expect(actual).toBe(vector.expectedSubjectId)
    if (actual) {
      expect(`host:${actual}`).toBe(vector.expectedSubject)
      expect(actual).not.toContain(vector.displayText)
    }
  })

  it('supports third-party provisioner subjects through the same helper', () => {
    expect(makeHostSubjectId('3rd', 'sandbox-recipes', 'daily-report')).toBe(
      '3rd:sandbox-recipes/daily-report'
    )
    expect(makeHostSubjectId('3rd', 'sandbox-recipes', '../daily-report')).toBeNull()
  })
})
