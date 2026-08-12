#!/usr/bin/env node
/**
 * issue #299 Phase 2 — CI gate for the vendored provider-netblocks seed.
 *
 * Parses the seed ConfigMap, runs every category through the SAME pure core the
 * runtime uses, and asserts it is non-empty and within the etcd size budget. The
 * seed is machine-generated with a fixed shape, so a minimal literal-block reader
 * is used (the repo root has no node_modules / yaml dependency).
 *
 * zero-is-never-success: exits 1 if ZERO categories were checked (a broken parse
 * or an empty seed must fail, never pass).
 *
 * Usage: node scripts/ci/validate-provider-netblocks-seed.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const core = require('../../packages/network-policy-core/index.cjs')
const registry = require('../../packages/network-policy-core/providerRegistry.cjs')

const HERE = dirname(fileURLToPath(import.meta.url))
const SEED = join(HERE, '..', '..', 'deploy', 'base', 'control-plane', 'provider-netblocks-configmap.yaml')
const MAX_CM_BYTES = 900_000

function fail(msg) {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

/** Minimal reader for the fixed `data:` / `  key: |-` / `    line` shape. */
function parseSeedData(text) {
  const lines = text.split('\n')
  let i = lines.findIndex(l => l.trimEnd() === 'data:')
  if (i < 0) fail('seed has no data: block')
  i++
  const data = {}
  while (i < lines.length) {
    const line = lines[i]
    const m = line.match(/^ {2}([A-Za-z0-9._-]+): \|-?\s*$/)
    if (m) {
      i++
      const valLines = []
      while (i < lines.length && (lines[i].startsWith('    ') || lines[i] === '')) {
        if (lines[i] !== '') valLines.push(lines[i].slice(4))
        i++
      }
      data[m[1]] = valLines.join('\n')
    } else if (line.trim() === '' || line.startsWith('#') || /^ {2}\S/.test(line)) {
      i++
    } else {
      break // dedented out of data:
    }
  }
  return data
}

const raw = readFileSync(SEED, 'utf8')
const data = parseSeedData(raw)

if (Object.keys(data).filter(k => k !== '_meta').length === 0) {
  fail('seed data has zero non-_meta keys (zero-is-never-success)')
}

const parsed = core.parseProviderNetblocks(data)
if (parsed.errors.length > 0) fail(`parseProviderNetblocks errors: ${parsed.errors.join('; ')}`)

let checked = 0
for (const [key, ranges] of Object.entries(parsed.categories)) {
  const source = key.split('.')[0]
  const v = core.validateProviderRanges(ranges, registry.providerBounds(source))
  if (v.kind !== 'ok') fail(`${key} failed validation: ${v.reasons.join('; ')}`)
  if (v.ranges.length === 0) fail(`${key} resolved to zero IPv4 ranges`)
  checked++
  console.error(`  OK ${key}: ${v.ranges.length} IPv4 ranges`)
}

if (checked === 0) fail('zero categories checked (zero-is-never-success)')

const size = Buffer.byteLength(JSON.stringify(data), 'utf8')
if (size > MAX_CM_BYTES) fail(`seed data ${size} bytes exceeds the ${MAX_CM_BYTES} byte budget`)

console.error(`OK: ${checked} categories validated, ${size} bytes (< ${MAX_CM_BYTES})`)
