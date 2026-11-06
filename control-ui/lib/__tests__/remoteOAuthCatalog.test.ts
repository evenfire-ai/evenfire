import { describe, expect, it } from 'vitest'
import {
  CURATOR_CIMD_ENTRY,
  CURATOR_INVALID_ENTRY,
  ORG_DCR_ENTRY,
  PLAIN_REMOTE_ENTRY,
} from '../../test/fixtures/catalogRemoteOAuthWire'
import type { RegistryEntry, RegistryInstalledState } from '../api'
import {
  getCatalogOAuthBlock,
  getRemoteOAuthCatalogBlock,
  getRemoteOAuthSlots,
  remoteOAuthProvenanceBadge,
} from '../oauthInstall'
import {
  buildCatalogRemoteInstallRequest,
  parseRemoteWizardQuery,
  resolveRemoteCatalogTarget,
} from '../remoteMcp'
import { safeHttpsHref } from '../vanillaMarkdown'

function withOAuth(entry: RegistryEntry, oauth: Record<string, unknown>): RegistryEntry {
  return { ...entry, mcp_server_meta: { ...entry.mcp_server_meta, oauth } }
}

describe('remote-OAuth catalog entries', () => {
  it('the baked/generic lane never claims a remote-OAuth entry, even one that also names a provider', () => {
    expect(getCatalogOAuthBlock(CURATOR_CIMD_ENTRY)).toBeNull()
    const withProvider = withOAuth(CURATOR_CIMD_ENTRY, {
      ...(CURATOR_CIMD_ENTRY.mcp_server_meta?.oauth as object),
      provider: 'github',
    })
    expect(getCatalogOAuthBlock(withProvider)).toBeNull()
    expect(getRemoteOAuthCatalogBlock(withProvider)).not.toBeNull()
  })

  it('reads control-api verdicts as they are served', () => {
    expect(getRemoteOAuthCatalogBlock(CURATOR_CIMD_ENTRY)).toMatchObject({
      valid: true,
      url: 'https://mcp.linear.app/mcp',
      trusted: true,
      publisher: null,
    })
    expect(getRemoteOAuthCatalogBlock(ORG_DCR_ENTRY)).toMatchObject({
      valid: true,
      trusted: false,
      publisher: '@acme',
    })
    expect(getRemoteOAuthCatalogBlock(CURATOR_INVALID_ENTRY)).toEqual({
      valid: false,
      reason: 'setup_guide_required',
    })
    expect(getRemoteOAuthCatalogBlock(PLAIN_REMOTE_ENTRY)).toBeNull()
  })

  it('identifies the subtype by `source` only, never by presentation keys', () => {
    // A provider-lane entry carrying a verification block is not remote-OAuth.
    const lookalike = withOAuth(PLAIN_REMOTE_ENTRY, {
      provider: 'github',
      verification: { status: 'verified' },
    })
    expect(getRemoteOAuthCatalogBlock(lookalike)).toBeNull()
    // `source: 'remote'` without a control-api verdict is remote-OAuth but not installable.
    const { remoteOAuth: _verdict, ...unresolved } = CURATOR_CIMD_ENTRY
    expect(getRemoteOAuthCatalogBlock(unresolved as RegistryEntry)).toEqual({
      valid: false,
      reason: 'unresolved',
    })
  })

  it('reads slot state as an own property only', () => {
    const installed = {
      remoteOAuthSlots: JSON.parse('{"@acme/x":{"user":{"kind":"foreign","serverName":"s"}}}'),
    } as Pick<RegistryInstalledState, 'remoteOAuthSlots'>
    expect(getRemoteOAuthSlots(installed, 'constructor')).toBeUndefined()
    expect(getRemoteOAuthSlots(installed, 'toString')).toBeUndefined()
    expect(getRemoteOAuthSlots(installed, '@acme/x')?.user).toEqual({
      kind: 'foreign',
      serverName: 's',
    })
    expect(getRemoteOAuthSlots({}, '@acme/x')).toBeUndefined()
  })

  it('badges an org entry with its publisher', () => {
    const view = getRemoteOAuthCatalogBlock(ORG_DCR_ENTRY)
    if (!view || view.valid === false) throw new Error('expected a valid view')
    expect(remoteOAuthProvenanceBadge(view)).toEqual({
      label: 'Unverified · published by @acme',
      tone: 'unverified',
    })
  })
})

describe('safeHttpsHref', () => {
  it.each([
    ['https://console.example.com/apps', 'https://console.example.com/apps'],
    ['http://console.example.com/', null],
    ['HTTPS://console.example.com/', null],
    ['//evil.example.com/x', null],
    ['/connectors', null],
    ['#section', null],
    ['mailto:ops@example.com', null],
    ['javascript:alert(1)', null],
    ['data:text/html,x', null],
    ['https:///no-host', null],
    ['https://user:pass@example.com/', null],
    ['https://exa mple.com/', null],
  ])('%s → %s', (input, expected) => {
    expect(safeHttpsHref(input)).toBe(expected)
  })
})

describe('catalog-mode wizard inputs', () => {
  it('parses the page query; a partial or unknown-scope link is an error', () => {
    expect(parseRemoteWizardQuery({ entry: null, version: null, scope: null })).toEqual({
      mode: 'manual',
    })
    expect(parseRemoteWizardQuery({ entry: '@a/b', version: '1.0.0', scope: 'user' })).toEqual({
      mode: 'catalog',
      entry: { name: '@a/b', version: '1.0.0' },
      grantScope: 'user',
    })
    expect(parseRemoteWizardQuery({ entry: '@a/b', version: null, scope: 'user' }).mode).toBe(
      'invalid'
    )
    for (const [entry, version] of [
      ['..', '1.0.0'],
      ['@acme/..', '1.0.0'],
      ['../x', '1.0.0'],
      ['@acme/x', '..'],
      ['@acme/x', '.'],
      ['@acme/x', '1.0.0/../2'],
    ]) {
      expect(parseRemoteWizardQuery({ entry, version, scope: 'user' }).mode).toBe('invalid')
    }
    expect(parseRemoteWizardQuery({ entry: '@a/b', version: '1', scope: 'admin' }).mode).toBe(
      'invalid'
    )
  })

  it('builds a catalog install body with the entry URL the wizard showed and no server name', () => {
    const resolved = resolveRemoteCatalogTarget(CURATOR_CIMD_ENTRY, 'user')
    if (!resolved.ok) throw new Error(resolved.message)
    const body = buildCatalogRemoteInstallRequest({
      target: resolved.target,
      mode: 'dcr',
      clientId: 'ignored',
      clientSecret: 'ignored',
    })
    const entryUrl = (
      CURATOR_CIMD_ENTRY.mcp_server_meta as { remoteEndpoints: Array<{ url: string }> }
    ).remoteEndpoints[0].url
    expect(body).toEqual({
      catalogEntry: { name: CURATOR_CIMD_ENTRY.name, version: CURATOR_CIMD_ENTRY.version },
      grantScope: 'user',
      baseUrl: entryUrl,
      mode: 'dcr',
    })
    expect(body).not.toHaveProperty('serverName')
  })
})
