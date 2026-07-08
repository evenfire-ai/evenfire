import { describe, expect, it } from 'vitest'
import { planPublish, PublishError, resolvePublishedStatus } from './gfsPublish'

/**
 * P4-S06 — artifact-reference publishing. Publish creates a gfs resource that
 * references (never copies) the artifact, requires write on the destination, and
 * resolves to expired once the artifact's TTL passes.
 */

describe('planPublish', () => {
  it('plans a reference requiring write on the destination folder', () => {
    const plan = planPublish({
      drive: 'main',
      parentResourceId: 'folder-1',
      name: 'report.pdf',
      artifactRef: 'artifact://store/abc',
      artifactExpiresAt: 1000,
    })
    expect(plan.kind).toBe('file')
    expect(plan.artifactRef).toBe('artifact://store/abc') // reference, not a copy
    expect(plan.requiredCheck).toEqual({ resourceId: 'folder-1', op: 'write' })
    expect(plan.artifactExpiresAt).toBe(1000)
  })

  it('rejects a publish without an artifactRef (publishing is by reference)', () => {
    expect(() => planPublish({ drive: 'main', parentResourceId: 'f', name: 'x', artifactRef: '' })).toThrow(
      PublishError
    )
  })

  it('rejects an invalid name (slash and control chars — no drift vs move/resources)', () => {
    expect(() =>
      planPublish({ drive: 'main', parentResourceId: 'f', name: 'a/b', artifactRef: 'artifact://x' })
    ).toThrow(/path_invalid|invalid name/i)
    // control chars (e.g. tab/NUL) must be rejected here too — the review found
    // this validator had drifted from move.ts / resources.ts.
    expect(() =>
      planPublish({ drive: 'main', parentResourceId: 'f', name: 'a\tb', artifactRef: 'artifact://x' })
    ).toThrow(PublishError)
  })
})

describe('resolvePublishedStatus', () => {
  it('is live before expiry and expired after (→ 410 artifact_expired)', () => {
    expect(resolvePublishedStatus(1000, 999)).toBe('live')
    expect(resolvePublishedStatus(1000, 1000)).toBe('expired')
    expect(resolvePublishedStatus(1000, 1001)).toBe('expired')
  })
  it('never expires when there is no TTL', () => {
    expect(resolvePublishedStatus(null, 9_999_999)).toBe('live')
  })
})
