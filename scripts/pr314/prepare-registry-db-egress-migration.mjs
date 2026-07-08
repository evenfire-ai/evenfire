#!/usr/bin/env node
/**
 * Prepare live Registry DB egress metadata migration.
 *
 * Dry-run by default. Reads the Registry API catalog, builds an allowlisted SQL
 * patch for entries whose stored mcp_server_meta must align with PR #314
 * public-web/exact-host semantics, and requires explicit --apply plus a DB URL.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

const REGISTRY_PAGE_LIMIT = 200

const KNOWN_REGISTRY_EGRESS = {
  'mcp-web-research': {
    egressSummary: {
      domains: ['api.search.brave.com', 'web.archive.org', 'archive.org'],
      ports: [80, 443],
      wideCidr: true,
    },
    reason:
      'Web research supports dynamic public page fetching; wideCidr is the compatibility trigger for PR #314 public-web egress.',
  },
}

function parseArgs(argv) {
  const args = {
    registryUrl: '',
    apply: false,
    databaseUrl: process.env.DATABASE_URL ?? '',
    snapshotFile: '',
    sqlFile: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--registry-url') args.registryUrl = argv[++i] ?? ''
    else if (arg === '--apply') args.apply = true
    else if (arg === '--database-url') args.databaseUrl = argv[++i] ?? ''
    else if (arg === '--snapshot-file') args.snapshotFile = argv[++i] ?? ''
    else if (arg === '--sql-file') args.sqlFile = argv[++i] ?? ''
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!args.registryUrl) throw new Error('--registry-url is required')
  if (args.apply && !args.databaseUrl) throw new Error('--apply requires --database-url or DATABASE_URL')
  if (args.apply && !args.snapshotFile) throw new Error('--apply requires --snapshot-file for rollback evidence')
  return args
}

function printHelp() {
  console.log(`Usage:
  node scripts/pr314/prepare-registry-db-egress-migration.mjs --registry-url <url>
  node scripts/pr314/prepare-registry-db-egress-migration.mjs --registry-url <url> --snapshot-file before.json --sql-file patch.sql
  node scripts/pr314/prepare-registry-db-egress-migration.mjs --registry-url <url> --snapshot-file before.json --apply --database-url <postgres-url>

Dry-run is default. --apply updates only allowlisted entry name/version rows and
requires a snapshot file path so rollback input is captured before mutation.
`)
}

function apiBase(registryUrl) {
  const root = registryUrl.replace(/\/$/, '')
  return root.endsWith('/api/v1') ? root : `${root}/api/v1`
}

async function fetchEntries(registryUrl) {
  const entries = []
  for (let offset = 0; ; offset += REGISTRY_PAGE_LIMIT) {
    const res = await fetch(
      `${apiBase(registryUrl)}/entries?limit=${REGISTRY_PAGE_LIMIT}&offset=${offset}`
    )
    if (!res.ok) throw new Error(`Registry API ${res.status}: ${await res.text()}`)
    const body = await res.json()
    const page = Array.isArray(body.data) ? body.data : []
    entries.push(...page)
    const total = Number(body.meta?.total)
    if (page.length === 0) break
    if (Number.isFinite(total) && entries.length >= total) break
    if (page.length < REGISTRY_PAGE_LIMIT) break
  }
  return entries
}

function normalizeMeta(row) {
  return row?.mcp_server_meta && typeof row.mcp_server_meta === 'object' ? row.mcp_server_meta : {}
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function jsonbQuote(value) {
  return `${sqlQuote(JSON.stringify(value))}::jsonb`
}

function buildSql(patches) {
  if (patches.length === 0) return '-- No registry egress metadata updates required.\n'
  return `${patches
    .map(
      patch => `UPDATE entries
SET mcp_server_meta = jsonb_set(coalesce(mcp_server_meta, '{}'::jsonb), '{egressSummary}', ${jsonbQuote(
        patch.nextEgressSummary
      )}, true),
    revision = revision + 1
WHERE name = ${sqlQuote(patch.name)}
  AND version = ${sqlQuote(patch.version)}
  AND status != 'removed';`
    )
    .join('\n\n')}\n`
}

function buildPatches(rows) {
  const patches = []
  for (const row of rows) {
    if (row.entry_type !== 'mcp-server') continue
    const known = KNOWN_REGISTRY_EGRESS[row.name]
    if (!known) continue
    const meta = normalizeMeta(row)
    const current = meta.egressSummary ?? null
    if (JSON.stringify(current) === JSON.stringify(known.egressSummary)) continue
    patches.push({
      name: row.name,
      version: row.version,
      reason: known.reason,
      currentEgressSummary: current,
      nextEgressSummary: known.egressSummary,
    })
  }
  return patches
}

const args = parseArgs(process.argv.slice(2))
const rows = await fetchEntries(args.registryUrl)
const patches = buildPatches(rows)
const snapshot = rows
  .filter(row => patches.some(patch => patch.name === row.name && patch.version === row.version))
  .map(row => ({
    name: row.name,
    version: row.version,
    mcp_server_meta: row.mcp_server_meta,
  }))
const sql = buildSql(patches)

if (args.snapshotFile) {
  fs.writeFileSync(args.snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`)
}
if (args.sqlFile) {
  fs.writeFileSync(args.sqlFile, sql)
}

const report = {
  generatedAt: new Date().toISOString(),
  dryRun: !args.apply,
  registryUrl: args.registryUrl,
  affectedRows: patches.length,
  patches,
  snapshotFile: args.snapshotFile || null,
  sqlFile: args.sqlFile || null,
}
console.log(JSON.stringify(report, null, 2))

if (args.apply && patches.length > 0) {
  const result = spawnSync('psql', [args.databaseUrl, '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    stdio: ['pipe', 'inherit', 'inherit'],
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
