import { describe, expect, it } from 'vitest'
import {
  checkEvenfireImageRefMatchesEntry,
  evenfireImageRefRepoPath,
} from '../src/routes/admin/registryImageRefIdentity.js'

const EVENFIRE = 'https://registry.evenfire.ai'

describe('evenfireImageRefRepoPath', () => {
  it('extracts org/name from a tagged evenfire ref', () => {
    expect(evenfireImageRefRepoPath('registry.evenfire.ai/acme/forecast:1.2.3', EVENFIRE)).toBe(
      'acme/forecast'
    )
  })
  it('extracts org/name from a digest-pinned evenfire ref', () => {
    expect(
      evenfireImageRefRepoPath(
        'registry.evenfire.ai/acme/forecast@sha256:' + 'a'.repeat(64),
        EVENFIRE
      )
    ).toBe('acme/forecast')
  })
  it('handles a nested repo path', () => {
    expect(evenfireImageRefRepoPath('registry.evenfire.ai/acme/team/forecast:1', EVENFIRE)).toBe(
      'acme/team/forecast'
    )
  })
  it('returns null for a non-evenfire host', () => {
    expect(evenfireImageRefRepoPath('us-central1-docker.pkg.dev/p/r/x:1', EVENFIRE)).toBeNull()
    expect(evenfireImageRefRepoPath('mongodb/mongodb-mcp-server:latest', EVENFIRE)).toBeNull()
  })
  it('returns null for empty / non-string / unconfigured registry', () => {
    expect(evenfireImageRefRepoPath('', EVENFIRE)).toBeNull()
    expect(evenfireImageRefRepoPath(undefined as unknown as string, EVENFIRE)).toBeNull()
    expect(evenfireImageRefRepoPath('registry.evenfire.ai/acme/forecast:1', '')).toBeNull()
  })
})

describe('checkEvenfireImageRefMatchesEntry', () => {
  it('passes when the evenfire repo path equals the scoped entry name', () => {
    expect(
      checkEvenfireImageRefMatchesEntry({
        isLocal: true,
        entryName: '@acme/forecast',
        image: 'registry.evenfire.ai/acme/forecast:1.2.3',
        registryUrl: EVENFIRE,
      })
    ).toEqual({ ok: true })
  })
  it('fails when the repo name differs from the entry name', () => {
    expect(
      checkEvenfireImageRefMatchesEntry({
        isLocal: true,
        entryName: '@acme/forecast',
        image: 'registry.evenfire.ai/acme/wrongname:1.2.3',
        registryUrl: EVENFIRE,
      })
    ).toEqual({ ok: false, expected: 'acme/forecast', actual: 'acme/wrongname' })
  })
  it('fails when the org differs (grant would resolve to a different entry)', () => {
    expect(
      checkEvenfireImageRefMatchesEntry({
        isLocal: true,
        entryName: '@acme/forecast',
        image: 'registry.evenfire.ai/other/forecast:1',
        registryUrl: EVENFIRE,
      })
    ).toEqual({ ok: false, expected: 'acme/forecast', actual: 'other/forecast' })
  })
  it('skips (ok) an unscoped entry name', () => {
    expect(
      checkEvenfireImageRefMatchesEntry({
        isLocal: true,
        entryName: 'airtable-mcp',
        image: 'registry.evenfire.ai/acme/airtable-mcp:1',
        registryUrl: EVENFIRE,
      })
    ).toEqual({ ok: true })
  })
  it('skips (ok) a non-evenfire image', () => {
    expect(
      checkEvenfireImageRefMatchesEntry({
        isLocal: true,
        entryName: '@acme/forecast',
        image: 'us-central1-docker.pkg.dev/p/r/forecast:1',
        registryUrl: EVENFIRE,
      })
    ).toEqual({ ok: true })
  })
  it('skips (ok) a remote entry', () => {
    expect(
      checkEvenfireImageRefMatchesEntry({
        isLocal: false,
        entryName: '@acme/forecast',
        image: 'registry.evenfire.ai/acme/wrongname:1',
        registryUrl: EVENFIRE,
      })
    ).toEqual({ ok: true })
  })
})
