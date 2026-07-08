#!/usr/bin/env node
/**
 * Prepare PR #314 egress migration patches.
 *
 * This script is dry-run by default. It can:
 * - print JSON patch operations for live McpServer and WorkflowRecipe resources;
 * - optionally apply those patches with --apply;
 * - optionally patch seed JSON files with --write-seeds for known seed entries.
 *
 * It intentionally does not guess arbitrary domains. Unknown internet MCPs are
 * reported as manual-review items.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')

const DUCKDUCKGO_EGRESS_BINDINGS = [
  { dns: 'duckduckgo.com', port: 443, protocol: 'TCP' },
  { dns: 'html.duckduckgo.com', port: 443, protocol: 'TCP' },
  { dns: 'lite.duckduckgo.com', port: 443, protocol: 'TCP' },
]

const WEB_SEARCH_ENV = [
  { name: 'DEFAULT_SEARCH_ENGINE', value: 'duckduckgo' },
  { name: 'ALLOWED_SEARCH_ENGINES', value: 'duckduckgo' },
  { name: 'ENABLE_CORS', value: 'true' },
]

const KNOWN_MCP_EGRESS = {
  'mcp-etherscan': {
    mode: 'exact-host',
    bindings: [{ dns: 'api.etherscan.io', port: 443, protocol: 'TCP' }],
    reason: 'Etherscan MCP uses the public Etherscan API host.',
  },
  'evm-safe-scanner': {
    mode: 'public-web',
    bindings: [{ egressClass: 'public-web' }],
    reason:
      'EVM safe scanner supports arbitrary EVM explorer endpoints across chains; exact-host cannot be complete without operator-provided explorer list.',
    requiresPublicWebApproval: true,
  },
  'mcp-web-research': {
    mode: 'public-web',
    bindings: [{ egressClass: 'public-web' }],
    seedSummary: {
      domains: ['api.search.brave.com', 'web.archive.org', 'archive.org'],
      ports: [80, 443],
      wideCidr: true,
    },
    reason:
      'Web research supports dynamic public page fetching; registry wideCidr is the compatibility trigger for PR #314 public-web egress.',
    requiresPublicWebApproval: true,
  },
}

function parseArgs(argv) {
  const args = {
    context: '',
    live: false,
    apply: false,
    allowPublicWeb: false,
    writeSeeds: false,
    workflowNamespace: 'sandbox-recipes',
    mcpNamespace: 'mcp-server',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--live') args.live = true
    else if (arg === '--context') args.context = argv[++i] ?? ''
    else if (arg === '--apply') args.apply = true
    else if (arg === '--allow-public-web') args.allowPublicWeb = true
    else if (arg === '--write-seeds') args.writeSeeds = true
    else if (arg === '--workflow-namespace') args.workflowNamespace = argv[++i] ?? ''
    else if (arg === '--mcp-namespace') args.mcpNamespace = argv[++i] ?? ''
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if ((args.live || args.apply) && !args.context) throw new Error('--context is required with --live/--apply')
  if (args.apply && !args.live) throw new Error('--apply requires --live')
  return args
}

function printHelp() {
  console.log(`Usage:
  node scripts/pr314/prepare-registry-egress-migration.mjs --live --context <ctx>
  node scripts/pr314/prepare-registry-egress-migration.mjs --live --context <ctx> --apply
  node scripts/pr314/prepare-registry-egress-migration.mjs --write-seeds

Default behavior is dry-run.

Options:
  --live                         Inspect live WorkflowRecipe/McpServer resources.
  --context <name>               Kubernetes context for live inspection or patching.
  --apply                        Apply generated Kubernetes JSON patches.
  --allow-public-web             Permit applying public-web patches.
  --write-seeds                  Patch known registry seed entries when present.
  --workflow-namespace <ns>      Default: sandbox-recipes.
  --mcp-namespace <ns>           Default: mcp-server.
`)
}

function kube(args, context, input) {
  return execFileSync('kubectl', ['--context', context, ...args], {
    input,
    encoding: 'utf8',
    stdio: input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  })
}

function readKubeJson(kind, namespace, context) {
  return JSON.parse(kube(['-n', namespace, 'get', kind, '-o', 'json'], context))
}

function hasBindings(bindings) {
  return Array.isArray(bindings) && bindings.length > 0
}

function jsonPointerSegment(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1')
}

function mergeEnv(existing, additions) {
  const byName = new Map((existing ?? []).map(item => [item.name, item]))
  for (const item of additions) byName.set(item.name, item)
  return [...byName.values()]
}

function buildLiveMcpPatches(data, args) {
  const patches = []
  const manual = []
  for (const item of data.items) {
    if (hasBindings(item.spec?.egressBindings)) continue
    const known = KNOWN_MCP_EGRESS[item.metadata.name]
    if (!known) continue
    if (known.requiresPublicWebApproval && !args.allowPublicWeb) {
      manual.push({
        kind: 'McpServer',
        namespace: item.metadata.namespace,
        name: item.metadata.name,
        reason: `${known.reason} Re-run with --allow-public-web to generate/apply this patch.`,
      })
      continue
    }
    patches.push({
      kind: 'McpServer',
      namespace: item.metadata.namespace,
      name: item.metadata.name,
      reason: known.reason,
      patch: [{ op: 'add', path: '/spec/egressBindings', value: known.bindings }],
    })
  }
  return { patches, manual }
}

function isWebSearchWorkload(workload) {
  return (
    workload?.transport &&
    (workload.id === 'web-search' ||
      /web[-_]?search/i.test(workload.id ?? '') ||
      /open-web-search|web-search-mcp/i.test(workload.image ?? ''))
  )
}

function buildLiveWorkflowRecipePatches(data) {
  const patches = []
  const manual = []
  for (const item of data.items) {
    const workloads = item.spec?.workloads ?? []
    const ops = []
    workloads.forEach((workload, index) => {
      if (!isWebSearchWorkload(workload)) return
      const workloadPath = `/spec/workloads/${index}`
      if (!hasBindings(workload.egressBindings)) {
        ops.push({
          op: 'add',
          path: `${workloadPath}/egressBindings`,
          value: DUCKDUCKGO_EGRESS_BINDINGS,
        })
      }
      const mergedEnv = mergeEnv(workload.env, WEB_SEARCH_ENV)
      if (JSON.stringify(mergedEnv) !== JSON.stringify(workload.env ?? [])) {
        ops.push({
          op: workload.env ? 'replace' : 'add',
          path: `${workloadPath}/env`,
          value: mergedEnv,
        })
      }

      const riskyTools = []
      for (const step of item.spec?.steps ?? []) {
        const include = step.allowedTools?.include ?? step.run?.capabilities?.mcp?.allowedTools?.include ?? []
        for (const tool of include) {
          if (typeof tool === 'string' && tool.startsWith(`${workload.id}__`) && tool !== `${workload.id}__search`) {
            riskyTools.push({ step: step.id, tool })
          }
        }
      }
      if (riskyTools.length > 0) {
        manual.push({
          kind: 'WorkflowRecipe',
          namespace: item.metadata.namespace,
          name: item.metadata.name,
          reason:
            'web-search workload can be restricted to DuckDuckGo egress, but steps still reference non-search tools; review before changing allowedTools.',
          riskyTools,
        })
      }
    })
    if (ops.length > 0) {
      patches.push({
        kind: 'WorkflowRecipe',
        namespace: item.metadata.namespace,
        name: item.metadata.name,
        reason: 'Add DuckDuckGo exact-host egress and default engine env to web-search workload.',
        patch: ops,
      })
    }
  }
  return { patches, manual }
}

function applyPatch(item, context) {
  const resource = item.kind.toLowerCase()
  const patchText = JSON.stringify(item.patch)
  kube(['-n', item.namespace, 'patch', resource, item.name, '--type=json', '-p', patchText], context)
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
}

function writeJsonFile(file, value) {
  fs.writeFileSync(path.join(ROOT, file), `${JSON.stringify(value, null, 2)}\n`)
}

function patchSeedEntries() {
  const changed = []
  const files = ['registry-api/seed/mcp-servers-local.json', 'registry-api/seed/mcp-servers-remote.json']
  for (const file of files) {
    const entries = readJsonFile(file)
    let dirty = false
    for (const entry of entries) {
      const known = KNOWN_MCP_EGRESS[entry.name]
      if (!known) continue
      if (!entry.mcpServer) continue
      const domains =
        known.mode === 'exact-host'
          ? known.bindings.filter(b => b.dns).map(b => b.dns)
          : known.seedSummary?.domains
      const ports =
        known.mode === 'exact-host'
          ? [...new Set(known.bindings.filter(b => b.port).map(b => b.port))]
          : known.seedSummary?.ports
      if (!domains || !ports) continue
      const next = { domains, ports, wideCidr: known.mode === 'public-web' }
      if (JSON.stringify(entry.mcpServer.egressSummary) !== JSON.stringify(next)) {
        entry.mcpServer.egressSummary = next
        dirty = true
        changed.push(`${file}:${entry.name}`)
      }
    }
    if (dirty) writeJsonFile(file, entries)
  }
  return changed
}

const args = parseArgs(process.argv.slice(2))
const report = {
  generatedAt: new Date().toISOString(),
  dryRun: !args.apply,
  seedChanges: [],
  livePatches: [],
  manualReview: [],
}

if (args.writeSeeds) {
  report.seedChanges = patchSeedEntries()
}

if (args.live) {
  const mcp = readKubeJson('mcpservers', args.mcpNamespace, args.context)
  const wr = readKubeJson('workflowrecipes', args.workflowNamespace, args.context)
  const mcpPlan = buildLiveMcpPatches(mcp, args)
  const wrPlan = buildLiveWorkflowRecipePatches(wr)
  report.livePatches = [...mcpPlan.patches, ...wrPlan.patches]
  report.manualReview = [...mcpPlan.manual, ...wrPlan.manual]
  if (args.apply) {
    for (const item of report.livePatches) applyPatch(item, args.context)
  }
}

console.log(JSON.stringify(report, null, 2))

if (report.manualReview.length > 0) process.exitCode = 3
