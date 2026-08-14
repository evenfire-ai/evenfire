import { describe, expect, it } from 'vitest'
import { normalizeBuildRevision } from '../src/buildRevision.js'

describe('normalizeBuildRevision', () => {
  // The 7 characters served must be the same ones that name the image tag
  // (`sha-<7>`), so an operator can match the API against what was pulled.
  it('shortens a full commit sha to the image tag form', () => {
    expect(normalizeBuildRevision('4be949df1c2b3a4d5e6f708192a3b4c5d6e7f809')).toBe('4be949d')
  })

  it('lowercases so it compares equal to the image tag', () => {
    expect(normalizeBuildRevision('4BE949DF1C2B3A4D5E6F708192A3B4C5D6E7F809')).toBe('4be949d')
  })

  it('leaves an already-short sha alone', () => {
    expect(normalizeBuildRevision('4be949d')).toBe('4be949d')
  })

  it('passes non-sha markers through instead of truncating them', () => {
    expect(normalizeBuildRevision('local')).toBe('local')
    expect(normalizeBuildRevision('dev-worktree')).toBe('dev-worktree')
  })

  it('reports nothing when no build stamped the image', () => {
    expect(normalizeBuildRevision(undefined)).toBe('')
    expect(normalizeBuildRevision(null)).toBe('')
    expect(normalizeBuildRevision('')).toBe('')
    expect(normalizeBuildRevision('   ')).toBe('')
  })
})
