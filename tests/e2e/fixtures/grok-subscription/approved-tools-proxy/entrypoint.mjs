// Only the external Grok model boundary is deterministic. No token is logged.
if (
  process.env.GROK_APPROVED_TOOLS_TEST_ONLY !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  !/^[a-z0-9][a-z0-9-]+$/.test(process.env.GROK_APPROVED_TOOLS_MINIKUBE_PROFILE || '') ||
  !process.env.KUBERNETES_SERVICE_HOST
)
  throw new Error('approved-tools Grok proxy requires explicit isolated Minikube test markers')

const { createServer } = await import('node:http')
const { default: express } = await import('express')
const { loadConfig } = await import('./dist/config.js')
const { createProxyApps } = await import('./dist/server.js')
const { createApprovedToolsUpstream } = await import('./test/approvedToolsUpstream.ts')
const upstream = createApprovedToolsUpstream('grok')
const config = loadConfig()
const servers = createProxyApps(config, {
  fetchFn: upstream.fetchFn,
  lookup: async hostname => {
    if (hostname !== 'cli-chat-proxy.grok.com') throw new Error('fixture_dns_operation_denied')
    // Origin policy validates this public address; fetch never contacts it.
    return [{ address: '104.18.32.47', family: 4 }]
  },
})
// Register before the production probe app's catch-all.
const probeApp = express()
probeApp.get('/approved-tools/evidence', (_req, res) => res.json(upstream.evidence()))
probeApp.use(servers.probeApp)
const probe = createServer(probeApp)
servers.runtime.listen(config.runtimePort)
servers.admin.listen(config.adminPort)
probe.listen(config.probePort)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    probe.close()
    void servers.close().then(() => process.exit(0))
  })
}
