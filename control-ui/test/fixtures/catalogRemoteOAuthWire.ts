/**
 * Producer fixtures for the Marketplace remote-OAuth lane: catalog entries as
 * `GET /admin/registry/entries/:name/versions/:version` serves them, and the
 * catalog-mode bodies of `POST /admin/mcp-servers/remote/discover` and
 * `POST /admin/mcp-servers/remote`.
 *
 * control-api is not importable from this package, so these are the golden wire files
 * control-api's own route test captures from the real routers (registry rows built by
 * the registry-row fixture, real provenance resolution, real discovery and transport
 * probe over recorded probe bytes, the real install saga):
 * control-api/test/routes.catalogRemoteOAuth.wireGoldens.test.ts →
 * control-api/test/fixtures/wire/catalogRemoteOAuth.*.json. A producer change breaks
 * the golden there before it can drift here.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { RegistryCatalogResponse, RegistryEntry } from '../../lib/api'
import type { DiscoverRemoteResponse, InstallRemoteResponse } from '../../lib/remoteMcp.types'
import type { WireCapture } from './remoteMcpWire'

const WIRE_DIR = resolve(__dirname, '../../../control-api/test/fixtures/wire')

function loadGolden<T>(name: string): WireCapture<T> {
  return JSON.parse(readFileSync(resolve(WIRE_DIR, `catalogRemoteOAuth.${name}.json`), 'utf8'))
}

function entry(name: string): RegistryEntry {
  const capture = loadGolden<RegistryEntry>(`entry.${name}`)
  if (capture.status !== 200) throw new Error(`entry golden ${name} is not a 200`)
  return capture.body
}

// ─── catalog entries (GET …/versions/:version, 200) ───────────────────────────

/** `@evenfire/linear-remote`: curator, both slots, CIMD, verified 2026-09-25, scopes `read`. */
export const CURATOR_CIMD_ENTRY = entry('curatorCimd')
/** `@evenfire/linear-user`: curator, user slot only, untested. */
export const CURATOR_CIMD_USER_ONLY_ENTRY = entry('curatorCimdUserOnly')
/** `@evenfire/workiq-remote`: curator, pre-registered on Entra (hint), guide + console, known issue. */
export const CURATOR_WORKIQ_ENTRY = entry('curatorWorkiq')
/** `@evenfire/hostile-guide`: curator, pre-registered, its guide carries every unsafe construct. */
export const CURATOR_HOSTILE_GUIDE_ENTRY = entry('curatorHostileGuide')
/** `@evenfire/linear-dcr`: curator expects DCR; Linear only takes a pre-registered client. */
export const CURATOR_DCR_ON_MANUAL_AS_ENTRY = entry('curatorDcrOnManualAs')
/** `@evenfire/linear-dcr-guided`: curator DCR entry with guide + console; Linear went pre-registered. */
export const CURATOR_DCR_WITH_GUIDE_ON_MANUAL_AS_ENTRY = entry('curatorDcrWithGuideOnManualAs')
/** `@evenfire/vercel-remote`: curator, its URL serves no MCP at that path. */
export const CURATOR_DEAD_URL_ENTRY = entry('curatorDeadUrl')
/** `@evenfire/broken-remote`: curator pre-registered without guide → `remoteOAuth.valid: false`. */
export const CURATOR_INVALID_ENTRY = entry('curatorInvalid')
/** `@acme/notion-remote`: org entry, its verified badge and guide stripped, `publisher: @acme`. */
export const ORG_DCR_ENTRY = entry('orgDcr')
/** `@acme/linear-pre`: org pre-registered, both slots, valid without a guide. */
export const ORG_PRE_REGISTERED_ENTRY = entry('orgPreRegistered')
/** `@evenfire/plain-remote`: a remote server with no OAuth block (not remote-OAuth). */
export const PLAIN_REMOTE_ENTRY = entry('plainRemote')

// ─── /discover in catalog mode ────────────────────────────────────────────────

/** {@link CURATOR_CIMD_ENTRY}, user slot, on Linear: CIMD, shared callback, no drift. */
export const CATALOG_CIMD_DISCOVER = loadGolden<DiscoverRemoteResponse>('discover.catalogCimd').body
/** DCR expected, the AS only takes a pre-registered client: `catalogDrift` dcr → manual. */
export const CATALOG_DRIFT_DCR_TO_MANUAL_DISCOVER = loadGolden<DiscoverRemoteResponse>(
  'discover.catalogDriftDcrToManual'
).body
/** {@link CURATOR_DCR_WITH_GUIDE_ON_MANUAL_AS_ENTRY}: drift dcr → manual on an entry with a guide. */
export const CATALOG_DRIFT_WITH_GUIDE_DISCOVER = loadGolden<DiscoverRemoteResponse>(
  'discover.catalogDriftWithGuide'
).body
/** {@link ORG_PRE_REGISTERED_ENTRY}, user slot: pre-registered on a per-server callback. */
export const CATALOG_ORG_PRE_REGISTERED_DISCOVER = loadGolden<DiscoverRemoteResponse>(
  'discover.catalogOrgPreRegistered'
).body
/** The entry's URL serves no MCP (Vercel `/mcp`): a dead probe with a suggested URL. */
export const CATALOG_DEAD_URL_DISCOVER =
  loadGolden<DiscoverRemoteResponse>('discover.catalogDeadUrl').body
/** {@link CURATOR_WORKIQ_ENTRY} with the tenant authority: entra-v2, pre-registered. */
export const CATALOG_WORKIQ_DISCOVER =
  loadGolden<DiscoverRemoteResponse>('discover.catalogWorkiq').body
/** {@link CURATOR_WORKIQ_ENTRY} without a tenant: 400 `tenant_required`. */
export const CATALOG_WORKIQ_TENANT_REQUIRED = loadGolden('discover.catalogWorkiqTenantRequired')
/** {@link CURATOR_INVALID_ENTRY}: 400 `catalog_entry_invalid`. */
export const CATALOG_INVALID_DISCOVER_FAILURE = loadGolden('discover.catalogInvalid')

// ─── install in catalog mode ──────────────────────────────────────────────────

export const CATALOG_CIMD_INSTALLED = loadGolden<InstallRemoteResponse>('install.catalogCimd').body
/** {@link ORG_PRE_REGISTERED_ENTRY}, user slot: 201 with the per-server redirect URI. */
export const CATALOG_PRE_REGISTERED_INSTALLED = loadGolden<InstallRemoteResponse>(
  'install.catalogPreRegistered'
).body
export const CATALOG_SERVER_NAME_IN_USE_FAILURE = loadGolden('install.catalogServerNameInUse')
/** A young `-oauth-client` Secret without a CR: another install of the slot is in flight. */
export const CATALOG_INSTALL_IN_PROGRESS_FAILURE = loadGolden('install.catalogInstallInProgress')
/** The entry's URL serves no MCP: 400 before any write, with the probe's suggested URL. */
export const CATALOG_TRANSPORT_UNREACHABLE_FAILURE = loadGolden(
  'install.catalogTransportUnreachable'
)
/** The context slot reusing the user slot's OAuth app. */
export const CATALOG_CLIENT_ID_IN_USE_FAILURE = loadGolden('install.catalogClientIdInUse')
/** An old `-oauth-client` Secret without a CR blocks the slot; the body names it. */
export const CATALOG_SLOT_RESIDUE_FAILURE = loadGolden('install.catalogSlotResidue')

// ─── GET /admin/registry/catalog (install slots) ──────────────────────────────

/**
 * Catalog with every slot state, over CRs the remote saga's builder produced:
 * - `@evenfire/linear-remote` user: canonical instance v1.0.0; context free;
 * - `@evenfire/linear-user` user: instance under the hand-picked name `hand-named-linear`;
 * - `@acme/linear-pre` user: canonical instance being deleted; context: its canonical
 *   name taken by a manual install (foreign);
 * - `@acme/notion-remote` user: free, with the manual `manual-notion` on the same URL;
 * - `@evenfire/linear-dcr` (untested, user slot) and `@evenfire/workiq-remote`
 *   (pre-registered, known issue): free; `@evenfire/broken-remote`
 *   (invalid) and `@evenfire/plain-remote` (not remote-OAuth): nothing installed.
 */
export const CATALOG_SLOTS = loadGolden<RegistryCatalogResponse>('catalog.slots').body
/** `@evenfire/linear-remote` served at v1.0.1 while its user slot holds a v1.0.0 instance. */
export const CATALOG_BUMPED_VERSION =
  loadGolden<RegistryCatalogResponse>('catalog.bumpedVersion').body

/** control-api's `normalizeRemoteBaseUrl` over a fixed set of inputs. */
export const NORMALIZE_BASE_URL_CASES =
  loadGolden<Array<{ input: string; normalized: string | null }>>('normalizeBaseUrl').body
