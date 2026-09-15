// Runs only in the isolated Control API test image. The host records identity
// intent before invoking this program; no production account is reused.
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE !== '1' ||
  !process.env.KUBERNETES_SERVICE_HOST
)
  throw new Error('Isolated test image required')

const inputChunks = []
let inputBytes = 0
for await (const chunk of process.stdin) {
  inputBytes += chunk.length
  if (inputBytes > 65_536) throw new Error('Identity input exceeds limit')
  inputChunks.push(chunk)
}
const input = JSON.parse(Buffer.concat(inputChunks, inputBytes).toString('utf8'))
if (!['create', 'cleanup'].includes(input.action)) throw new Error('Invalid identity action')
const { pool, withTransaction } = await import('/app/control-api/dist/db.js')
try {
  const { default: bcrypt } = await import('/app/control-api/node_modules/bcryptjs/index.js')
  const { appendControlApiPermissionEventsInTransaction } =
    await import('/app/control-api/dist/services/tracing/controlApiPermissionEvents.js')
  const { revokeCodexSubscriptionConnection } =
    await import('/app/control-api/dist/services/codexSubscriptionConnection.js')
  const { rebuildLiveCodexUnionAllowlist } =
    await import('/app/control-api/dist/services/codexSubscriptionCatalog.js')
  const { createFixtureIdentities, cleanupFixtureIdentities } =
    await import('/app/approved-tools-setup/identity-lifecycle.mjs')
  const publish = journal => process.stdout.write(JSON.stringify({ e2eIdentity: journal }) + '\n')
  const adapters = {
    env: process.env,
    withTransaction,
    hashPassword: (value, rounds) => bcrypt.hash(value, rounds),
    appendPermissionEvents: appendControlApiPermissionEventsInTransaction,
    revokeCodexSubscriptionConnection,
    rebuildLiveCodexUnionAllowlist,
    publishRuntimeAllowlist: async () => {
      const { KubeConfig, CoreV1Api } =
        await import('/app/control-api/node_modules/@kubernetes/client-node/dist/index.js')
      const { config } = await import('/app/control-api/dist/config.js')
      const { LlmAllowedModelsConfigMapWriter } =
        await import('/app/control-api/dist/services/llmAllowedModelsConfigMap.js')
      const clusterConfig = new KubeConfig()
      clusterConfig.loadFromCluster()
      const writer = new LlmAllowedModelsConfigMapWriter(
        clusterConfig.makeApiClient(CoreV1Api),
        config.hostsNamespace
      )
      await writer.materialize()
    },
    saveJournal: publish,
  }
  if (input.action === 'create') {
    await createFixtureIdentities(input, { ...adapters, initialJournal: input.initialJournal })
  } else {
    await cleanupFixtureIdentities(input, input.initialJournal, adapters)
  }
} catch {
  process.stderr.write('Fixture identity operation failed; retain the host journal for recovery\n')
  process.exitCode = 1
} finally {
  await pool.end()
}
