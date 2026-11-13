import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  type RemoteOAuthGrantScope,
  deriveCatalogRemoteServerName,
} from '../src/routes/admin/catalogRemoteOAuth.js'
import { generateRegistryName } from '../src/routes/admin/registry.js'

/**
 * Golden of the McpServer names control-api produces, consumed by mcp-host's
 * wire tool-name tests (mcp-host/src/llm/__tests__/fixtures/serverNames.json).
 * mcp-host prefixes every tool with `<serverName>__`, so the length of the
 * server name decides how much room the tool name has on the provider wire.
 * mcp-host cannot import control-api, so instead of retyping names there,
 * every name here is emitted by the real producer.
 *
 * `registry` holds names from `generateRegistryName` (registry installs). The
 * version is part of the name and the whole name is trimmed at 63, so a long
 * version reaches the K8s label ceiling.
 * `catalog` holds names from `deriveCatalogRemoteServerName` (one McpServer per
 * catalog install slot). It ignores the version and caps the slug, so its names
 * stop at 55; both scopes are listed because the scope changes tag and hash.
 *
 * A producer change fails the equality below and forces the golden to move. To
 * regenerate after an intended change:
 * `UPDATE_WIRE_GOLDENS=1 npx vitest run test/mcpHost.serverNames.golden.test.ts`,
 * then review the JSON diff in mcp-host.
 */

const UPDATE = process.env.UPDATE_WIRE_GOLDENS === '1'
const GOLDEN_DIR = new URL('../../mcp-host/src/llm/__tests__/fixtures/', import.meta.url)
const GOLDEN_FILE = new URL('serverNames.json', GOLDEN_DIR)

const K8S_LABEL_MAX = 63
// `mcp-` + slug (capped at 40) + `-u-`/`-c-` + 8 hex chars.
const CATALOG_NAME_MAX = 55
const RFC1123_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

type RegistryGoldenEntry = { entryName: string; version: string; name: string }
type CatalogGoldenEntry = { catalogId: string; grantScope: RemoteOAuthGrantScope; name: string }
type ServerNamesGolden = { registry: RegistryGoldenEntry[]; catalog: CatalogGoldenEntry[] }

const REGISTRY_INPUTS: ReadonlyArray<{ entryName: string; version: string }> = [
  // Sample inputs in the curated catalog's `@evenfire/<name>` format; these
  // entries are not published by any seed in this tree yet.
  { entryName: '@evenfire/notion-remote', version: '1.0.0' },
  { entryName: '@evenfire/atlassian-remote', version: '1.0.0' },
  // Slug longer than the 40-char cap: the slug is cut, the version and hash survive.
  { entryName: '@evenfire/google-workspace-admin-directory-remote', version: '1.0.0' },
  // Capped slug plus a long version: the whole name is cut at 63, eating the hash.
  { entryName: '@evenfire/google-workspace-admin-directory-remote', version: '10.20.300-beta.12' },
]

const CATALOG_INPUTS: ReadonlyArray<{ catalogId: string; grantScope: RemoteOAuthGrantScope }> = [
  { catalogId: '@evenfire/notion-remote', grantScope: 'user' },
  { catalogId: '@evenfire/notion-remote', grantScope: 'context' },
  { catalogId: '@evenfire/atlassian-remote', grantScope: 'user' },
  { catalogId: '@evenfire/atlassian-remote', grantScope: 'context' },
  // Slug longer than the 40-char cap: the name reaches its 55-char maximum.
  { catalogId: '@evenfire/google-workspace-admin-directory-remote', grantScope: 'user' },
  { catalogId: '@evenfire/google-workspace-admin-directory-remote', grantScope: 'context' },
]

function produce(): ServerNamesGolden {
  return {
    registry: REGISTRY_INPUTS.map(({ entryName, version }) => ({
      entryName,
      version,
      name: generateRegistryName(entryName, version),
    })),
    catalog: CATALOG_INPUTS.map(({ catalogId, grantScope }) => ({
      catalogId,
      grantScope,
      name: deriveCatalogRemoteServerName(catalogId, grantScope),
    })),
  }
}

function readGolden(actual: ServerNamesGolden): ServerNamesGolden {
  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(GOLDEN_FILE, `${JSON.stringify(actual, null, 2)}\n`)
  }
  let raw: string
  try {
    raw = readFileSync(GOLDEN_FILE, 'utf8')
  } catch {
    throw new Error(
      `missing golden ${GOLDEN_FILE.pathname}; generate it with UPDATE_WIRE_GOLDENS=1`
    )
  }
  return JSON.parse(raw) as ServerNamesGolden
}

describe('mcp-host server-name golden', () => {
  const actual = produce()

  it('the golden matches what the producers emit now', () => {
    const golden = readGolden(actual)
    expect(
      actual,
      `${GOLDEN_FILE.pathname} is stale: the server-name producer changed. ` +
        'Regenerate with UPDATE_WIRE_GOLDENS=1 and review the diff in mcp-host.'
    ).toEqual(golden)
  })

  it('every produced name is an RFC 1123 label of at most 63 chars', () => {
    for (const { name } of [...actual.registry, ...actual.catalog]) {
      expect(name.length, name).toBeLessThanOrEqual(K8S_LABEL_MAX)
      expect(name).toMatch(RFC1123_LABEL)
    }
  })

  it('the registry entries reach the 63-char ceiling, so mcp-host is tested at the worst case', () => {
    const lengths = actual.registry.map(({ name }) => name.length)
    expect(Math.max(...lengths)).toBe(K8S_LABEL_MAX)
  })

  it('the catalog entries reach the 55-char catalog maximum', () => {
    const lengths = actual.catalog.map(({ name }) => name.length)
    expect(Math.max(...lengths)).toBe(CATALOG_NAME_MAX)
  })
})
