#!/usr/bin/env node
/**
 * PR #314 registry and live-cluster egress readiness audit.
 *
 * Default mode is local/seed-only and read-only. Add --live --context <ctx> to
 * inspect the currently installed WorkflowRecipe/McpServer resources.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')

const DUCKDUCKGO_HOSTS = new Set(['duckduckgo.com', 'html.duckduckgo.com', 'lite.duckduckgo.com'])
const WEB_SEARCH_WORKLOAD_IDS = new Set(['web-search', 'mcp-web-research', 'web-research'])
const REGISTRY_PAGE_LIMIT = 200
const STALE_WEB_SEARCH_FIXTURE_FILES = [
  'control-ui/e2e/registry-mythos-workflow.spec.ts',
  'control-ui/e2e/gke-workflow-mythos.spec.ts',
  'desktop-app/test/e2e-playwright/workflow-competitive-intel-happy-path.test.ts',
  'scripts/minikube/recreate-research-recipe.sh',
]
const KNOWN_EXTERNAL_MCP_HINTS = [
  /etherscan/i,
  /blockscout/i,
  /safe-scanner/i,
  /evm-safe/i,
  /web[-_]?research/i,
  /web[-_]?search/i,
  /brave/i,
  /github/i,
  /airtable/i,
  /fred/i,
  /edgar/i,
  /\bsec[-_ ]?edgar\b/i,
  /coinglass/i,
  /coinmarketcap/i,
  /coingecko/i,
  /defillama/i,
  /glassnode/i,
  /tavily/i,
  /stripe/i,
]

function parseArgs(argv) {
  const args = {
    live: false,
    context: '',
    kubeNamespaceWorkflow: 'sandbox-recipes',
    kubeNamespaceMcp: 'mcp-server',
    registryUrl: '',
    json: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--live') args.live = true
    else if (arg === '--json') args.json = true
    else if (arg === '--context') args.context = argv[++i] ?? ''
    else if (arg === '--workflow-namespace') args.kubeNamespaceWorkflow = argv[++i] ?? ''
    else if (arg === '--mcp-namespace') args.kubeNamespaceMcp = argv[++i] ?? ''
    else if (arg === '--registry-url') args.registryUrl = argv[++i] ?? ''
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (args.live && !args.context) {
    throw new Error('--context is required with --live')
  }
  return args
}

function printHelp() {
  console.log(`Usage:
  node scripts/pr314/audit-registry-egress.mjs
  node scripts/pr314/audit-registry-egress.mjs --live --context <kube-context>

Options:
  --live                         Also inspect live Kubernetes resources.
  --context <name>               Kubernetes context for live inspection.
  --workflow-namespace <ns>      WorkflowRecipe namespace. Default: sandbox-recipes.
  --mcp-namespace <ns>           McpServer namespace. Default: mcp-server.
  --registry-url <url>           Optional registry API base URL; accepts root or /api/v1.
  --json                         Emit JSON only.
`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
}

function issue(list, severity, code, message, details = {}) {
  list.push({ severity, code, message, details })
}

function shouldNeedExternalEgress(entry) {
  const haystack = [
    entry.name,
    entry.description,
    entry.mcpServer?.imageRef,
    ...(entry.tags ?? []),
    ...(entry.mcpServer?.tools ?? []),
  ]
    .filter(Boolean)
    .join(' ')
  return KNOWN_EXTERNAL_MCP_HINTS.some(re => re.test(haystack))
}

function normalizeEgressSummary(entry) {
  const summary = entry.mcpServer?.egressSummary
  if (!summary) return { domains: [], ports: [], wideCidr: false }
  return {
    domains: Array.isArray(summary.domains) ? summary.domains.filter(Boolean) : [],
    ports: Array.isArray(summary.ports) ? summary.ports : [],
    wideCidr: summary.wideCidr === true,
  }
}

function normalizeRegistryApiEntry(row) {
  if (row.entry_type !== 'mcp-server') return null
  const meta = row.mcp_server_meta ?? {}
  return {
    name: row.name,
    description: row.description,
    tags: row.tags ?? [],
    mcpServer: {
      serverMode: row.server_mode ?? meta.serverMode,
      transport: row.transport ?? meta.transport,
      imageRef: meta.imageRef,
      tools: meta.tools ?? [],
      remoteEndpoints: meta.remoteEndpoints ?? [],
      egressSummary: meta.egressSummary,
    },
  }
}

function auditMcpSeeds(issues) {
  const files = ['registry-api/seed/mcp-servers-local.json', 'registry-api/seed/mcp-servers-remote.json']
  const entries = files.flatMap(file => readJson(file).map(entry => ({ ...entry, __file: file })))
  const summary = { total: entries.length, withEgressSummary: 0, publicWeb: [] }

  for (const entry of entries) {
    const egress = normalizeEgressSummary(entry)
    if (egress.domains.length > 0) summary.withEgressSummary += 1
    if (egress.wideCidr) summary.publicWeb.push(entry.name)

    const mode = entry.mcpServer?.serverMode
    const remoteEndpoints = entry.mcpServer?.remoteEndpoints ?? []
    if (mode === 'remote') {
      if (!Array.isArray(remoteEndpoints) || remoteEndpoints.length === 0) {
        issue(issues, 'error', 'remote-without-endpoint', `${entry.name} is remote but has no remoteEndpoints`, {
          file: entry.__file,
        })
      }
      if (egress.domains.length === 0) {
        issue(issues, 'error', 'remote-without-egress-summary', `${entry.name} is remote but has no egressSummary.domains`, {
          file: entry.__file,
        })
      }
    }

    if (shouldNeedExternalEgress(entry) && egress.domains.length === 0) {
      issue(issues, 'warning', 'external-looking-mcp-without-egress-summary', `${entry.name} looks external but has no egressSummary`, {
        file: entry.__file,
        imageRef: entry.mcpServer?.imageRef,
      })
    }

    if (egress.wideCidr) {
      issue(issues, 'info', 'public-web-registry-entry', `${entry.name} declares wideCidr:true; install path must translate it to explicit public-web egress`, {
        file: entry.__file,
        exampleDomains: egress.domains,
        publicWebPorts: [80, 443],
      })
    }
  }

  return summary
}

async function auditRegistryApi(issues, registryUrl) {
  const root = registryUrl.replace(/\/$/, '')
  const apiBase = root.endsWith('/api/v1') ? root : `${root}/api/v1`
  const rows = []
  for (let offset = 0; ; offset += REGISTRY_PAGE_LIMIT) {
    const res = await fetch(`${apiBase}/entries?limit=${REGISTRY_PAGE_LIMIT}&offset=${offset}`)
    if (!res.ok) {
      throw new Error(`Registry API ${res.status}: ${await res.text()}`)
    }
    const body = await res.json()
    const page = Array.isArray(body.data) ? body.data : []
    rows.push(...page)
    const total = Number(body.meta?.total)
    if (page.length === 0) break
    if (Number.isFinite(total) && rows.length >= total) break
    if (page.length < REGISTRY_PAGE_LIMIT) break
  }
  const entries = rows.map(normalizeRegistryApiEntry).filter(Boolean)
  const summary = { totalEntries: rows.length, mcpServers: entries.length, withEgressSummary: 0, publicWeb: [] }

  for (const entry of entries) {
    const egress = normalizeEgressSummary(entry)
    if (egress.domains.length > 0) summary.withEgressSummary += 1
    if (egress.wideCidr) summary.publicWeb.push(entry.name)
    if (entry.mcpServer?.serverMode === 'remote' && egress.domains.length === 0) {
      issue(issues, 'error', 'registry-api-remote-without-egress-summary', `${entry.name} is remote in registry API but has no egressSummary.domains`, {})
    }
    if (shouldNeedExternalEgress(entry) && egress.domains.length === 0) {
      issue(issues, 'warning', 'registry-api-external-looking-mcp-without-egress-summary', `${entry.name} looks external in registry API but has no egressSummary`, {
        imageRef: entry.mcpServer?.imageRef,
      })
    }
    if (egress.wideCidr) {
      issue(issues, 'info', 'registry-api-public-web-entry', `${entry.name} declares wideCidr:true in registry API; install path must translate it to explicit public-web egress`, {
        exampleDomains: egress.domains,
        publicWebPorts: [80, 443],
      })
    }
  }

  return summary
}

function auditFixtureFiles(issues) {
  const summary = { scanned: 0, staleFetchTools: [], missingDuckDuckGoEnv: [], missingEgressBindings: [] }
  for (const file of STALE_WEB_SEARCH_FIXTURE_FILES) {
    const abs = path.join(ROOT, file)
    if (!fs.existsSync(abs)) continue
    summary.scanned += 1
    const text = fs.readFileSync(abs, 'utf8')
    const usesOpenWebSearch = /open-web-search|web-search-mcp/i.test(text)
    if (/web-search__fetchWebContent|fetchWebContent/i.test(text)) {
      summary.staleFetchTools.push(file)
      issue(
        issues,
        'warning',
        'stale-web-search-fetch-tool',
        `${file} references fetchWebContent; prefer exact-host DuckDuckGo search-only unless the fixture explicitly tests public-web`,
        {}
      )
    }
    if (usesOpenWebSearch && !/ALLOWED_SEARCH_ENGINES/.test(text)) {
      summary.missingDuckDuckGoEnv.push(file)
      issue(
        issues,
        'warning',
        'web-search-fixture-missing-allowed-engines',
        `${file} uses open-web-search without ALLOWED_SEARCH_ENGINES=duckduckgo`,
        {}
      )
    }
    if (usesOpenWebSearch && !/egressBindings/.test(text)) {
      summary.missingEgressBindings.push(file)
      issue(
        issues,
        'error',
        'web-search-fixture-missing-egress-bindings',
        `${file} uses open-web-search without explicit egressBindings`,
        {}
      )
    }
  }
  return summary
}

async function tryLoadYaml() {
  try {
    return await import('js-yaml')
  } catch {
    return null
  }
}

async function auditRecipeSeeds(issues) {
  const yaml = await tryLoadYaml()
  const entries = readJson('registry-api/seed/recipes.json')
  const summary = { total: entries.length, transportWorkloads: 0, missingEgressBindings: [] }

  for (const entry of entries) {
    if (typeof entry.recipe !== 'string') continue
    let recipe
    try {
      recipe = yaml ? yaml.load(entry.recipe) : null
    } catch (err) {
      issue(issues, 'warning', 'recipe-yaml-parse-failed', `${entry.name} recipe YAML could not be parsed`, {
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    const workloads = recipe?.spec?.workloads ?? []
    for (const workload of workloads) {
      if (!workload?.transport) continue
      summary.transportWorkloads += 1
      const egressBindings = Array.isArray(workload.egressBindings) ? workload.egressBindings : []
      if (egressBindings.length === 0) {
        summary.missingEgressBindings.push(`${entry.name}:${workload.id}`)
        const looksExternal = WEB_SEARCH_WORKLOAD_IDS.has(workload.id) || shouldNeedExternalEgress({
          name: workload.id,
          description: recipe?.spec?.description,
          mcpServer: { imageRef: workload.image, tools: [] },
          tags: [],
        })
        issue(
          issues,
          looksExternal ? 'error' : 'info',
          'recipe-transport-without-egress-bindings',
          `${entry.name} workload ${workload.id} has transport but no egressBindings`,
          { image: workload.image, likelyExternal: looksExternal }
        )
      }
    }
  }

  return summary
}

function kube(args, context) {
  return execFileSync('kubectl', ['--context', context, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function readKubeJson(kind, namespace, context) {
  const args = namespace ? ['-n', namespace, 'get', kind, '-o', 'json'] : ['get', kind, '-A', '-o', 'json']
  return JSON.parse(kube(args, context))
}

function bindingCount(bindings) {
  return Array.isArray(bindings) ? bindings.length : 0
}

function auditLiveMcpServers(issues, args) {
  const data = readKubeJson('mcpservers', args.kubeNamespaceMcp, args.context)
  const summary = { total: data.items.length, withEgressBindings: 0, withoutEgressBindings: [] }
  for (const item of data.items) {
    const bindings = item.spec?.egressBindings ?? []
    if (bindingCount(bindings) > 0) {
      summary.withEgressBindings += 1
      continue
    }
    summary.withoutEgressBindings.push(item.metadata.name)
    const looksExternal = shouldNeedExternalEgress({
      name: item.metadata.name,
      description: item.spec?.description,
      mcpServer: { imageRef: item.spec?.image, tools: [] },
      tags: [],
    })
    issue(
      issues,
      looksExternal ? 'error' : 'info',
      'live-mcpserver-without-egress-bindings',
      `${item.metadata.namespace}/${item.metadata.name} has no spec.egressBindings`,
      { image: item.spec?.image, likelyExternal: looksExternal }
    )
  }
  return summary
}

function auditLiveWorkflowRecipes(issues, args) {
  const data = readKubeJson('workflowrecipes', args.kubeNamespaceWorkflow, args.context)
  const summary = { total: data.items.length, transportWorkloads: 0, missingEgressBindings: [] }
  for (const item of data.items) {
    const workloads = item.spec?.workloads ?? []
    for (const workload of workloads) {
      if (!workload?.transport) continue
      summary.transportWorkloads += 1
      const bindings = workload.egressBindings ?? []
      if (bindingCount(bindings) > 0) continue
      const ref = `${item.metadata.name}:${workload.id}`
      summary.missingEgressBindings.push(ref)
      const looksExternal =
        WEB_SEARCH_WORKLOAD_IDS.has(workload.id) ||
        shouldNeedExternalEgress({
          name: workload.id,
          description: item.spec?.description,
          mcpServer: { imageRef: workload.image, tools: [] },
          tags: [],
        })
      issue(
        issues,
        looksExternal ? 'error' : 'info',
        'live-workflow-transport-without-egress-bindings',
        `${item.metadata.namespace}/${item.metadata.name} workload ${workload.id} has transport but no egressBindings`,
        { image: workload.image, likelyExternal: looksExternal }
      )
    }
  }
  return summary
}

function auditLiveBroadPolicies(issues, args) {
  const data = readKubeJson('networkpolicy', args.kubeNamespaceMcp, args.context)
  const broad = data.items
    .filter(item => item.metadata?.name?.endsWith('-mcp-servers-egress-internet'))
    .map(item => `${item.metadata.namespace}/${item.metadata.name}`)
  for (const name of broad) {
    issue(
      issues,
      'warning',
      'legacy-wrc-broad-mcp-egress-policy',
      `${name} is a legacy WRC broad MCP-server egress policy that PR #314 should prune`,
      {}
    )
  }
  return { legacyBroadPolicies: broad.length, names: broad }
}

function printHuman(report) {
  console.log('# PR #314 registry egress readiness audit')
  console.log(`Generated: ${report.generatedAt}`)
  console.log('')
  console.log('## Summary')
  console.log(JSON.stringify(report.summary, null, 2))
  console.log('')
  console.log('## Findings')
  if (report.issues.length === 0) {
    console.log('No findings.')
    return
  }
  for (const item of report.issues) {
    console.log(`- [${item.severity}] ${item.code}: ${item.message}`)
    const detailKeys = Object.keys(item.details ?? {})
    if (detailKeys.length > 0) console.log(`  ${JSON.stringify(item.details)}`)
  }
}

const args = parseArgs(process.argv.slice(2))
const issues = []
const summary = {}
summary.mcpSeedCatalog = auditMcpSeeds(issues)
summary.recipeSeedCatalog = await auditRecipeSeeds(issues)
summary.fixtureCatalog = auditFixtureFiles(issues)

if (args.registryUrl) {
  summary.registryApiCatalog = await auditRegistryApi(issues, args.registryUrl)
}

if (args.live) {
  summary.liveMcpServers = auditLiveMcpServers(issues, args)
  summary.liveWorkflowRecipes = auditLiveWorkflowRecipes(issues, args)
  summary.liveBroadPolicies = auditLiveBroadPolicies(issues, args)
}

const report = {
  generatedAt: new Date().toISOString(),
  mode: args.live ? 'seed-and-live' : 'seed-only',
  summary,
  issues,
}

if (args.json) console.log(JSON.stringify(report, null, 2))
else printHuman(report)

const hasErrors = issues.some(item => item.severity === 'error')
process.exit(hasErrors ? 2 : 0)
