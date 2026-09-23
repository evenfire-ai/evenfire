#!/usr/bin/env node
/**
 * Regenerates `control-api/src/data/modelsDevSnapshot.ts` from the public
 * models.dev catalog.
 *
 * PREREQUISITE: `npm run build` in `control-api` first. This script imports
 * `PROVIDER_KEY_MAP` from the BUILT module (`dist/services/modelsDevClient.js`)
 * rather than duplicating the provider-key list, so the snapshot can never be
 * trimmed to a set of keys the code no longer maps.
 *
 *   cd control-api && npm run build && node scripts/regenerate-models-dev-snapshot.mjs
 *
 * Offline / reproducible runs read a saved payload instead of fetching. The
 * capture time of a saved file is something only the person who saved it knows,
 * so it must be supplied — it is never guessed from the file's mtime:
 *
 *   node scripts/regenerate-models-dev-snapshot.mjs \
 *     --input ./api.json --captured-at 2026-09-18T16:16:10.000Z
 *
 * Every failure throws and exits non-zero: a snapshot regenerated from partial
 * data is worse than no regeneration at all.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_KEY_MAP } from '../dist/services/modelsDevClient.js'

const CATALOG_URL = 'https://models.dev/api.json'
const HERE = dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = join(HERE, '..', 'src', 'data', 'modelsDevSnapshot.ts')

/** Minimal flag parser — `--input <path>` and `--captured-at <iso>` only. */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag !== '--input' && flag !== '--captured-at') {
      throw new Error(`Unknown argument: ${flag}`)
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`)
    }
    out[flag === '--input' ? 'input' : 'capturedAt'] = value
    i += 1
  }
  if (out.capturedAt !== undefined && out.input === undefined) {
    throw new Error('--captured-at is only meaningful with --input')
  }
  if (out.input !== undefined && out.capturedAt === undefined) {
    throw new Error(
      '--input requires --captured-at <iso>: a saved payload carries no capture time, and ' +
        'stamping it with the current clock would rejuvenate stale evidence'
    )
  }
  if (out.capturedAt !== undefined) {
    const parsed = new Date(out.capturedAt)
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`--captured-at is not a valid date: ${out.capturedAt}`)
    }
    out.capturedAt = parsed.toISOString()
  }
  return out
}

/**
 * Reads the catalog and the instant it was captured. For a live run the stamp is
 * taken immediately BEFORE the request, so it can never overstate the data's
 * freshness.
 */
async function loadCatalog(args) {
  if (args.input !== undefined) {
    const payload = JSON.parse(readFileSync(args.input, 'utf8'))
    return { payload, capturedAt: args.capturedAt }
  }
  const capturedAt = new Date().toISOString()
  const response = await fetch(CATALOG_URL)
  if (!response.ok) {
    throw new Error(`GET ${CATALOG_URL} failed: ${response.status} ${response.statusText}`)
  }
  return { payload: await response.json(), capturedAt }
}

const isStringArray = value => Array.isArray(value) && value.every(v => typeof v === 'string')

/**
 * Trims one models.dev entry to the fields discovery consumes. `modalities.input`
 * is copied VERBATIM when it is an array of strings and omitted otherwise: the
 * tri-state classifier treats absence as `unknown` at load time, so the snapshot
 * stays a faithful trim rather than a normalized rewrite that would bake one
 * interpretation of malformed upstream data into the vendored file.
 */
function trimModel(raw) {
  const trimmed = { id: raw.id }
  if (typeof raw.name === 'string') trimmed.name = raw.name
  if (typeof raw.limit?.context === 'number') trimmed.limit = { context: raw.limit.context }
  if (isStringArray(raw.modalities?.input)) trimmed.modalities = { input: raw.modalities.input }
  return trimmed
}

function buildSnapshot(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('models.dev payload is not an object')
  }
  const catalog = {}
  let models = 0
  let withImage = 0
  let droppedIds = 0
  for (const key of Object.values(PROVIDER_KEY_MAP)) {
    const provider = payload[key]
    if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) {
      throw new Error(
        `models.dev has no provider "${key}". PROVIDER_KEY_MAP must be corrected, not skipped: ` +
          'silently dropping the key would make that provider look like it has no models.'
      )
    }
    const entry = {}
    if (typeof provider.name === 'string') entry.name = provider.name
    entry.models = {}
    for (const raw of Object.values(provider.models ?? {})) {
      if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string') {
        droppedIds += 1
        continue
      }
      const trimmed = trimModel(raw)
      entry.models[raw.id] = trimmed
      models += 1
      if (trimmed.modalities?.input.includes('image')) withImage += 1
    }
    catalog[key] = entry
  }
  return {
    catalog,
    stats: { providers: Object.keys(catalog).length, models, withImage, droppedIds },
  }
}

function render(catalog, capturedAt) {
  return `/**
 * VENDORED offline snapshot of the public models.dev catalog
 * (https://models.dev/api.json, MIT-licensed). GENERATED DATA — do not edit by hand.
 *
 * Trimmed to only the ~22 models.dev provider keys that control-api maps to its
 * providers, and to only the fields discovery consumes
 * ({ id, name?, limit.context?, modalities.input? }).
 * Used by services/modelsDevClient.ts as the offline fallback when the LIVE fetch
 * of api.json fails, so catalog sync always has data. Regenerate with:
 *
 *   cd control-api && npm run build && node scripts/regenerate-models-dev-snapshot.mjs
 *
 * Shape mirrors the normalized catalog: providerKey -> { name?, models: id -> entry }.
 */
import type { RawModelsDevCatalog } from '../services/modelsDevClient.js'

/**
 * When this snapshot's data was captured from the public catalog — the instant
 * the regeneration script read api.json, NOT the time it is loaded. The script
 * writes it; never edit it by hand.
 *
 * Catalog evidence must never be rejuvenated by re-reading an old file (a
 * vendored fallback is a static offline copy, not a fresh observation).
 */
export const VENDORED_MODELS_DEV_SNAPSHOT_CAPTURED_AT = '${capturedAt}'

export const VENDORED_MODELS_DEV_SNAPSHOT: RawModelsDevCatalog = ${JSON.stringify(catalog, null, 2)}
`
}

const args = parseArgs(process.argv.slice(2))
const { payload, capturedAt } = await loadCatalog(args)
const { catalog, stats } = buildSnapshot(payload)
writeFileSync(OUTPUT_PATH, render(catalog, capturedAt), 'utf8')
execFileSync('npx', ['prettier', '--write', OUTPUT_PATH], {
  cwd: join(HERE, '..'),
  stdio: 'inherit',
})

console.log(
  [
    `providers: ${stats.providers}`,
    `models:    ${stats.models}`,
    `accept image: ${stats.withImage}`,
    `dropped (no string id): ${stats.droppedIds}`,
    `bytes:     ${statSync(OUTPUT_PATH).size}`,
    `capturedAt: ${capturedAt}`,
  ].join('\n')
)
