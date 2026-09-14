/** Install the real issue-627 baseline in the already-owned local Minikube. */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const profile = process.env.MINIKUBE_PROFILE
const context = process.env.CONTROL_API_REAL_PG_CONTEXT
if (!profile || context !== profile || !/^clerum-[a-z0-9-]+-[a-f0-9]{8}$/.test(profile))
  throw new Error('An explicit matching branch-owned Minikube profile/context is required')

function run(executable, args, input, timeout = 30000) {
  const result = spawnSync(executable, args, {
    cwd: root, input, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error || result.signal || result.status !== 0)
    throw new Error(`${executable} operation failed; no response bodies are logged`)
  return result.stdout
}
run('bash', ['scripts/minikube/require-t2-mutation-lock.sh'])
const kc = args => ['--context', context, '--request-timeout=20s', ...args]
function kubectl(args, value) {
  return run('kubectl', kc(args), value === undefined ? undefined : JSON.stringify(value))
}
function read(resource, namespace, name) {
  const result = kubectl(['-n', namespace, 'get', resource, name, '--ignore-not-found', '-o', 'json'])
  return result.trim() ? JSON.parse(result) : undefined
}
function source(repository, file) {
  const commit = JSON.parse(run('gh', ['api', `repos/keyper-labs/${repository}/commits/HEAD`])).sha
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid source revision')
  const entry = JSON.parse(run('gh', ['api', `repos/keyper-labs/${repository}/contents/${file}?ref=${commit}`]))
  return { commit, value: JSON.parse(Buffer.from(entry.content, 'base64').toString('utf8')) }
}

const host = read('hosts', 'mcp-host', 'chatllm')
if (host?.spec?.model?.provider !== 'codex-subscription' || !host.spec.contextRef)
  throw new Error('chatllm must already use the approved Codex subscription')
const pluginSource = source('worktracker-plugin', 'recipe/worktracker.json')
const wikiSource = source('mcp-servers-collection', 'mcp-wikipedia/registry.json')
const recipe = pluginSource.value
const expectedImages = new Set([
  'postgres:16-alpine',
  'registry.evenfire.ai/evenfire/worktracker-api:2.2.5',
  'registry.evenfire.ai/evenfire/worktracker-mcp:2.2.5',
  'registry.evenfire.ai/evenfire/worktracker-ui:2.2.5',
])
const workloads = recipe.spec?.workloads
if (recipe.kind !== 'WorkflowRecipe' || recipe.metadata?.name !== 'worktracker' ||
    !Array.isArray(workloads) || workloads.length !== 4 ||
    workloads.some(workload => !expectedImages.has(workload.image)))
  throw new Error('Worktracker source changed; review its images before installation')
if (wikiSource.value.version !== '1.0.0' || wikiSource.value.tools?.length !== 11)
  throw new Error('Wikipedia catalog changed; review baseline before installation')

const labels = { 'evenfire.ai/e2e-suite': 'issue-627-real-baseline' }
recipe.metadata = { ...recipe.metadata, namespace: 'sandbox-recipes', labels: { ...recipe.metadata.labels, ...labels } }
// Test data stays local; do not start optional meeting ingestion or background enrichment.
for (const workload of workloads)
  for (const entry of workload.env ?? [])
    if (['FEATURE_MEETINGS', 'FEATURE_PATTERNS_CRON', 'FEATURE_GITHUB', 'FEATURE_SEMANTIC_SEARCH'].includes(entry.name))
      entry.value = 'false'

const wikipedia = {
  apiVersion: 'clerum.io/v1alpha1', kind: 'McpServer',
  metadata: { name: 'issue-627-wikipedia', namespace: 'mcp-server', labels },
  spec: {
    contextRef: host.spec.contextRef,
    image: 'registry.evenfire.ai/evenfire/mcp-wikipedia:1.0.0',
    imagePullPolicy: 'IfNotPresent', enabled: true,
    description: 'Issue 627 real Wikipedia baseline',
    transport: { type: 'streamableHttp', port: 3000, url: 'http://issue-627-wikipedia.mcp-server.svc.cluster.local:3000/mcp' },
    auth: { type: 'none' }, healthCheck: { port: 3000 },
    egressBindings: [{ egressClass: 'public-web' }],
    resources: { requests: { cpu: '25m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
    env: [{ name: 'PORT', value: '3000' }],
  },
}
// These are new, recipe-owned local credentials, never copies of another cluster.
const shared = randomBytes(32).toString('hex')
const database = randomBytes(24).toString('hex')
const bundles = ['sandbox-recipes', 'mcp-server'].map(namespace => ({
  apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
  metadata: { name: 'worktracker-secrets', namespace, labels: { ...labels, 'clerum.io/owner-recipe': 'worktracker' } },
  stringData: namespace === 'sandbox-recipes'
    ? { 'pg-password': database, 'mcp-api-token': shared }
    : { 'mcp-api-token': shared },
}))
const objects = [recipe, ...bundles, wikipedia]
for (const object of objects)
  if (read(object.kind, object.metadata.namespace, object.metadata.name))
    throw new Error(`Existing ${object.kind}/${object.metadata.name}; refusing replacement or credential rotation`)
// Validate resource shapes before creation. Secrets follow the owning recipe.
for (const object of [recipe, wikipedia])
  kubectl(['create', '--dry-run=server', '-f', '-', '-o', 'name'], object)
for (const object of objects) {
  kubectl(['create', '-f', '-', '-o', 'name'], object)
  process.stdout.write(`CREATED ${object.kind}/${object.metadata.namespace}/${object.metadata.name}\n`)
}
process.stdout.write(JSON.stringify({
  status: 'resources-created-not-certified', profile,
  revisions: { worktracker: pluginSource.commit, wikipedia: wikiSource.commit },
  next: 'Verify workloads and effective tools/list; grant connector access through the platform before the real chat test.',
}) + '\n')
