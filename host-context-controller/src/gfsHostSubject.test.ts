import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeExpectedHostGfsSubject } from './gfsHostSubject'

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
    path.join(__dirname, '../../tests/contracts/gfs-host-subject-vectors.json'),
    'utf8'
  )
) as HostSubjectVector[]

describe('makeExpectedHostGfsSubject', () => {
  it.each(vectors)('matches the Control API identity contract: $label', vector => {
    const actual = makeExpectedHostGfsSubject(vector.namespace, vector.name)

    expect(actual).toBe(vector.expectedSubject)
    if (actual) {
      expect(actual).toBe(`host:${vector.expectedSubjectId}`)
      expect(actual).not.toContain(vector.displayText)
    }
  })

  it('does not accept display text in place of trusted metadata.name', () => {
    const vector = vectors.find(candidate => candidate.expectedSubject !== null)
    expect(vector).toBeDefined()
    expect(makeExpectedHostGfsSubject(vector!.namespace, vector!.displayText)).toBeNull()
  })

  it('reserves the legacy fleet-wide standalone subject without rejecting standalone elsewhere', () => {
    expect(makeExpectedHostGfsSubject('mcp-host', 'standalone')).toBeNull()
    expect(makeExpectedHostGfsSubject('sandbox-recipes', 'standalone')).toBe(
      'host:1st:sandbox-recipes/standalone'
    )
    expect(makeExpectedHostGfsSubject('mcp-host', 'standalone-worker')).toBe(
      'host:1st:mcp-host/standalone-worker'
    )
  })
})
