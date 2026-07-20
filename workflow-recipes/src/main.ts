/**
 * Clerum Operator entry point.
 *
 * Follows context-mapper/src/main.ts pattern:
 * 1. Load config
 * 2. Create provider (K8s watcher or dev mock)
 * 3. Start MCP server
 * 4. Graceful shutdown on SIGTERM/SIGINT
 *
 * Source of truth: PHASE-4-MCP-SERVER-INTERFACE.md §5.4
 */
import * as k8s from '@kubernetes/client-node'
import { OperatorConfig, loadConfig } from './config'
import { WorkflowRecipeProvider, createWorkflowRecipeProvider } from './k8sClient'
import { ClerumMcpServer } from './mcp/server'
import { assertInternalControlJwtHmacSecret } from './utils/internalControlSigner'

let provider: WorkflowRecipeProvider | null = null
let mcpServer: ClerumMcpServer | null = null
let isShuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log(`\n[Clerum] Received ${signal} — shutting down`)

  if (mcpServer) {
    await mcpServer.stop()
  }

  if (provider) {
    await provider.stop()
  }

  console.log('[Clerum] Shutdown complete')
  process.exit(0)
}

async function validateInfrastructure(config: OperatorConfig, kc: k8s.KubeConfig): Promise<void> {
  if (config.devMode) return
  const coreApi = kc.makeApiClient(k8s.CoreV1Api)

  try {
    assertInternalControlJwtHmacSecret(config.internalControlJwtWrcHmacSecret)
  } catch (err) {
    throw new Error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`)
  }

  // Verify WRC public key ConfigMap exists and is not a placeholder.
  // This implicitly validates the sandbox namespace exists (readNamespacedConfigMap
  // fails with 404/403 if the namespace is missing). Using ConfigMap read instead of
  // readNamespace because the WRC ServiceAccount has ConfigMap permissions in
  // sandbox-recipes but NOT cluster-scoped namespace read permissions.
  try {
    const cm = await coreApi.readNamespacedConfigMap({
      name: 'clerum-wrc-public-key',
      namespace: config.sandboxNamespace,
    })
    const key = cm.data?.['CLERUM_WRC_SIGNING_PUBLIC_KEY'] ?? ''
    if (!key.startsWith('-----BEGIN')) {
      throw new Error(
        `[FATAL] ConfigMap "clerum-wrc-public-key" in "${config.sandboxNamespace}" has placeholder value "${key.substring(0, 30)}...". ` +
          `Run: make gcp-gen-keys (or deploy/scripts/gen-jwt-keys.sh) to populate it.`
      )
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('[FATAL]')) throw err
    throw new Error(
      `[FATAL] ConfigMap "clerum-wrc-public-key" not found in "${config.sandboxNamespace}" ` +
        `(namespace may not exist or RBAC may be missing). ` +
        `Run: kubectl apply -f deploy/base/namespaces.yaml && make gcp-gen-keys`
    )
  }

  console.log(
    `[Clerum] Infrastructure validated: namespace="${config.sandboxNamespace}", WRC public key OK`
  )
}

async function main(): Promise<void> {
  const config = loadConfig()

  console.log('─────────────────────────────────────────')
  console.log('  Clerum Operator v0.1.0')
  console.log(`  Mode: ${config.devMode ? 'DEV' : 'PRODUCTION'}`)
  console.log(`  Port: ${config.port}`)
  console.log(`  McpServer namespace: ${config.namespace}`)
  console.log(`  WorkflowRecipe namespace: ${config.sandboxNamespace}`)
  console.log(`  NetworkPolicy enforcement mode: ${config.networkPolicyEnforcementMode}`)
  console.log(`  NetworkPolicy enforcement confirmed: ${config.networkPolicyEnforcementConfirmed}`)
  console.log('─────────────────────────────────────────')

  // Initialize K8s client (shared for validation + MCP server)
  const kc = new k8s.KubeConfig()
  kc.loadFromDefault()

  // Validate infrastructure before starting
  await validateInfrastructure(config, kc)

  // Start provider
  provider = createWorkflowRecipeProvider()
  await provider.start()

  // Start MCP server
  const customApi = kc.makeApiClient(k8s.CustomObjectsApi)
  // provider.start() above already initialized the workflow subsystem and
  // cached the signing key inside the reconciler. Pull the factory now so
  // configureModel + getArtifact can sign fresh ephemeral tokens per call.
  const tokenFactory = provider.getTokenFactory() ?? undefined
  mcpServer = new ClerumMcpServer(
    provider,
    config.port,
    customApi,
    config.namespace,
    kc,
    config.sandboxNamespace,
    tokenFactory
  )
  await mcpServer.start()

  // Graceful shutdown
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))

  console.log('[Clerum] Operator ready')
}

main().catch(error => {
  console.error('[Clerum] Fatal error:', error)
  process.exit(1)
})
