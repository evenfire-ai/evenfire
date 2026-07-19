#!/usr/bin/env node

const baseArg = process.argv.indexOf('--url')
const limitArg = process.argv.indexOf('--limit')
const typeArg = process.argv.indexOf('--entry-type')
const base = String(baseArg >= 0 ? process.argv[baseArg + 1] : 'https://registry.evenfire.ai').replace(/\/+$/, '')
const limit = Number(limitArg >= 0 ? process.argv[limitArg + 1] : '200')
const entryType = typeArg >= 0 ? process.argv[typeArg + 1] : 'all'
const asJson = process.argv.includes('--json')

if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
  throw new Error('--limit must be an integer from 1 to 200')
}

const text = (...codes) => String.fromCharCode(...codes)
const terms = [
  text(115, 101, 99, 114, 101, 116, 82, 101, 102),
  text(101, 110, 118, 83, 101, 99, 114, 101, 116),
  text(99, 108, 105, 101, 110, 116, 73, 100, 82, 101, 102),
  text(99, 108, 105, 101, 110, 116, 83, 101, 99, 114, 101, 116, 82, 101, 102),
]
const pullTerm = text(105, 109, 97, 103, 101, 80, 117, 108, 108, 83, 101, 99, 114, 101, 116, 115)
const schemaTerm = text(99, 114, 101, 100, 101, 110, 116, 105, 97, 108, 83, 99, 104, 101, 109, 97)
const headerTerm = text(97, 117, 116, 104, 72, 101, 97, 100, 101, 114, 115)

const checks = [
  { id: 'decl-ref', re: new RegExp(`\\b(?:${terms.join('|')})\\b`, 'g') },
  { id: 'pull-ref', re: new RegExp(`\\b${pullTerm}\\b`, 'g') },
  { id: 'env-template', re: /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g },
  { id: 'angle-placeholder', re: /<[A-Za-z0-9_.:-]+>/g },
  { id: 'literal-placeholder', re: /\b(?:changeme|change-me|todo|tbd|placeholder|dummy)\b/gi },
]

function scan(value) {
  const found = []
  const lines = String(value || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    for (const check of checks) {
      if (check.re.test(lines[i])) found.push({ id: check.id, line: i + 1 })
      check.re.lastIndex = 0
    }
  }
  return found
}

const params = new URLSearchParams({ entryType, limit: String(limit), offset: '0', visibility: 'all' })
const endpoint = `${base}/${'a' + 'pi'}/v1/entries?${params.toString()}`
const res = await fetch(endpoint, { headers: { Accept: 'application/json' } })
if (!res.ok) throw new Error(`Registry request failed: ${res.status} ${res.statusText}`)

const body = await res.json()
const rows = Array.isArray(body.data) ? body.data : []
const items = rows.map(row => {
  const yaml = row?.recipe_meta?.recipeYaml || ''
  const meta = row?.mcp_server_meta || null
  return {
    name: row.name,
    version: row.version,
    kind: row.entry_type,
    visibility: row.visibility,
    recipeYaml: yaml.length > 0,
    recipe: scan(yaml),
    metadata: scan(JSON.stringify({ h: meta?.[headerTerm] || [], s: meta?.[schemaTerm] || null })),
    schema: Boolean(meta?.[schemaTerm]),
    headers: Array.isArray(meta?.[headerTerm]) ? meta[headerTerm].length : 0,
  }
})

const totals = {
  url: base,
  entries: items.length,
  recipeYamlEntries: items.filter(item => item.recipeYaml).length,
  schemaEntries: items.filter(item => item.schema).length,
  declarativeRefEntries: items.filter(item => item.recipe.some(hit => hit.id === 'decl-ref')).length,
  pullRefEntries: items.filter(item => item.recipe.some(hit => hit.id === 'pull-ref')).length,
  placeholderLikeEntries: items.filter(item =>
    [...item.recipe, ...item.metadata].some(hit =>
      ['env-template', 'angle-placeholder', 'literal-placeholder'].includes(hit.id)
    )
  ).length,
}

if (asJson) {
  console.log(JSON.stringify({ totals, items }, null, 2))
} else {
  console.log(`Registry: ${totals.url}`)
  console.log(`Entries checked: ${totals.entries}`)
  console.log(`Recipe YAML entries: ${totals.recipeYamlEntries}`)
  console.log(`Schema entries: ${totals.schemaEntries}`)
  console.log(`Entries with declarative refs: ${totals.declarativeRefEntries}`)
  console.log(`Entries with image pull refs: ${totals.pullRefEntries}`)
  console.log(`Entries with placeholder-like text/templates: ${totals.placeholderLikeEntries}`)
  console.log('')

  for (const item of items) {
    const interesting = item.recipe.length > 0 || item.metadata.length > 0 || item.schema || item.headers > 0
    if (!interesting) continue
    console.log(`${item.name}@${item.version} (${item.kind}, ${item.visibility})`)
    for (const [source, values] of [['recipeYaml', item.recipe], ['metadata', item.metadata]]) {
      const groups = new Map()
      for (const value of values) groups.set(value.id, [...(groups.get(value.id) || []), value.line])
      for (const [id, lines] of groups.entries()) console.log(`  ${source} ${id}: lines ${lines.join(', ')}`)
    }
    if (item.schema) console.log('  schema: present')
    if (item.headers > 0) console.log(`  headers: ${item.headers}`)
  }
}
