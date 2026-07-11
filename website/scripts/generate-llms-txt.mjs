#!/usr/bin/env node
/**
 * Generates llms.txt (curated index) and llms-full.txt (full concatenation)
 * into the build output, so LLM agents can consume the docs directly —
 * same pattern used by Hermes Agent and OpenClaw docs sites.
 *
 * Runs as `postbuild` (after `docusaurus build`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const websiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const docsDir = path.resolve(websiteDir, '../docs')
const buildDir = path.join(websiteDir, 'build')

const SITE_URL = process.env.DOCS_URL ?? 'https://evenfire-ai.github.io'
const BASE_URL = process.env.DOCS_BASE_URL ?? '/evenfire/'

// Keep in sync with the `exclude` list in docusaurus.config.ts.
const EXCLUDED_DIRS = new Set(['agents', 'control-ui', 'desktop-ui-ux'])

const SECTION_ORDER = [
  ['.', 'Overview'],
  ['getting-started', 'Getting Started'],
  ['architecture', 'Architecture'],
  ['crds', 'CRD Reference'],
  ['deploy', 'Deployment'],
  ['features', 'Features'],
  ['testing', 'Testing'],
  ['reference', 'Reference'],
]

function collectMarkdownFiles(dir, relBase = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('_')) continue
      out.push(...collectMarkdownFiles(path.join(dir, entry.name), rel))
    } else if (entry.name.endsWith('.md')) {
      out.push(rel)
    }
  }
  return out
}

function routeFor(relPath) {
  let route = relPath.replace(/\.md$/, '')
  route = route.replace(/(^|\/)(README|index)$/i, '$1')
  route = route.replace(/\/$/, '')
  return `${SITE_URL}${BASE_URL}${route}`.replace(/\/$/, '') || `${SITE_URL}${BASE_URL}`
}

function titleFor(content, relPath) {
  const fmTitle = content.match(/^---\n[\s\S]*?\btitle:\s*(.+?)\n[\s\S]*?\n---/)
  if (fmTitle) return fmTitle[1].replace(/^['"]|['"]$/g, '').trim()
  const h1 = content.match(/^#\s+(.+)$/m)
  if (h1) return h1[1].trim()
  return relPath
}

if (!fs.existsSync(buildDir)) {
  console.error(`Build directory not found: ${buildDir} — run \`npm run build\` first.`)
  process.exit(1)
}

const files = collectMarkdownFiles(docsDir).sort()
const bySection = new Map(SECTION_ORDER.map(([key]) => [key, []]))

const fullParts = []
for (const rel of files) {
  const content = fs.readFileSync(path.join(docsDir, rel), 'utf8')
  const section = rel.includes('/') ? rel.split('/')[0] : '.'
  const entry = {
    title: titleFor(content, rel),
    url: routeFor(rel),
  }
  if (!bySection.has(section)) bySection.set(section, [])
  bySection.get(section).push(entry)
  fullParts.push(`\n\n----------\n# Source: docs/${rel}\n----------\n\n${content}`)
}

let llms = `# evenfire\n\n> Self-hostable, Kubernetes-native platform for LLM agents — multi-channel (Telegram/Email/Slack), first-class MCP, and a declarative workflow engine. All configuration is driven by Kubernetes CRDs under the clerum.io API group.\n\nDocs: ${SITE_URL}${BASE_URL}\nRepository: https://github.com/evenfire-ai/evenfire\nFull docs as one file: ${SITE_URL}${BASE_URL}llms-full.txt\n`

for (const [key, label] of SECTION_ORDER) {
  const entries = bySection.get(key)
  if (!entries || entries.length === 0) continue
  llms += `\n## ${label}\n\n`
  for (const { title, url } of entries) {
    llms += `- [${title}](${url})\n`
  }
}

fs.writeFileSync(path.join(buildDir, 'llms.txt'), llms)
fs.writeFileSync(
  path.join(buildDir, 'llms-full.txt'),
  `# evenfire — full documentation (${files.length} pages)\n${fullParts.join('')}`
)

console.log(`Generated llms.txt (${files.length} pages indexed) and llms-full.txt in build/`)
