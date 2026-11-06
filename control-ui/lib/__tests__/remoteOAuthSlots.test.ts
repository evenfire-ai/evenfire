import { describe, expect, it } from 'vitest'
import { CATALOG_SLOTS, NORMALIZE_BASE_URL_CASES } from '../../test/fixtures/catalogRemoteOAuthWire'
import type { RegistryEntry } from '../api'
import { getRemoteOAuthCatalogBlock } from '../oauthInstall'
import type { RemoteOAuthCatalogView } from '../oauthInstall.types'
import {
  normalizeRemoteBaseUrl,
  remoteOAuthManualNotice,
  remoteOAuthSlotRows,
  remoteOAuthVerificationKind,
} from '../remoteOAuthSlots'

function catalogEntry(name: string): RegistryEntry {
  const entry = CATALOG_SLOTS.data.find(candidate => candidate.name === name)
  if (!entry) throw new Error(`no ${name} in the catalog golden`)
  return entry
}

function validView(name: string): Extract<RemoteOAuthCatalogView, { valid: true }> {
  const view = getRemoteOAuthCatalogBlock(catalogEntry(name))
  if (!view?.valid) throw new Error(`${name} is not a valid remote-OAuth entry`)
  return view
}

describe('normalizeRemoteBaseUrl', () => {
  it('maps every case exactly as control-api does', () => {
    expect(NORMALIZE_BASE_URL_CASES.length).toBeGreaterThan(10)
    for (const { input, normalized } of NORMALIZE_BASE_URL_CASES) {
      expect({ input, normalized: normalizeRemoteBaseUrl(input) }).toEqual({ input, normalized })
    }
  })
})

describe('remoteOAuthSlotRows', () => {
  it('reads each slot from remoteOAuthSlots, one row per allowed grant scope', () => {
    expect(
      remoteOAuthSlotRows(
        validView('@evenfire/linear-remote'),
        '@evenfire/linear-remote',
        CATALOG_SLOTS.installed
      ).map(row => [row.scope, row.status.kind])
    ).toEqual([
      ['user', 'installed'],
      ['context', 'free'],
    ])
    expect(
      remoteOAuthSlotRows(
        validView('@acme/linear-pre'),
        '@acme/linear-pre',
        CATALOG_SLOTS.installed
      ).map(row => row.status)
    ).toEqual([
      { kind: 'uninstalling', serverName: 'mcp-acme-linear-pre-u-64164363945f' },
      { kind: 'occupied', serverName: 'mcp-acme-linear-pre-c-610fdec359b9' },
    ])
  })

  it('flags a manual install of the same URL in the same grant scope only', () => {
    const rows = remoteOAuthSlotRows(
      validView('@acme/notion-remote'),
      '@acme/notion-remote',
      CATALOG_SLOTS.installed
    )
    // The golden also holds a per-context manual install of this URL; the entry has no
    // context slot, so it must not surface on the user slot.
    expect(rows.map(row => row.manualMatches.map(server => server.serverName))).toEqual([
      ['manual-notion'],
    ])
    expect(remoteOAuthManualNotice(rows[0])).toBe(
      "Manual instance with this URL: 'manual-notion' (per user)"
    )
  })

  it('matches the manual URL after the server normalization, not by string equality', () => {
    const view = validView('@acme/notion-remote')
    // The same endpoint spelled the way an entry may publish it: case, default port and
    // a trailing slash differ, the comparison form does not.
    const respelled = { ...view, url: 'HTTPS://MCP.Notion.com:443/mcp/' }
    expect(
      remoteOAuthSlotRows(respelled, '@acme/notion-remote', CATALOG_SLOTS.installed)[0]
        .manualMatches
    ).toHaveLength(1)
  })

  it('finds no manual match when the URL differs', () => {
    const view = validView('@evenfire/linear-remote')
    const rows = remoteOAuthSlotRows(view, '@evenfire/linear-remote', CATALOG_SLOTS.installed)
    expect(view.block.allowedGrantScopes.length).toBeGreaterThan(0)
    expect(rows).toHaveLength(view.block.allowedGrantScopes.length)
    for (const row of rows) expect(row.manualMatches).toEqual([])
  })
})

describe('remoteOAuthVerificationKind', () => {
  it('buckets curator entries by verification and every org entry as third-party', () => {
    expect(remoteOAuthVerificationKind(validView('@evenfire/linear-remote'))).toBe('verified')
    expect(remoteOAuthVerificationKind(validView('@evenfire/linear-user'))).toBe('untested')
    expect(remoteOAuthVerificationKind(validView('@evenfire/workiq-remote'))).toBe('known-issue')
    expect(remoteOAuthVerificationKind(validView('@acme/notion-remote'))).toBe('third-party')
  })
})
