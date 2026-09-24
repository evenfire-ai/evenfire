// This file is copied only into the isolated Minikube E2E image.
if (
  process.env.CODEX_APPROVED_TOOLS_TEST_ONLY !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  !/^[a-z0-9][a-z0-9-]+$/.test(process.env.CODEX_APPROVED_TOOLS_MINIKUBE_PROFILE || '') ||
  !process.env.KUBERNETES_SERVICE_HOST
) {
  throw new Error('approved-tools proxy requires explicit isolated Minikube test markers')
}
const { createServer } = await import('node:http')
const { default: express } = await import('express')
const { loadConfig } = await import('./dist/config.js')
const { createProxyApps } = await import('./dist/server.js')
const { createApprovedToolsUpstream } = await import('./test/approvedToolsUpstream.ts')
const simulator = createApprovedToolsUpstream()
const config = loadConfig()
// Only the external model boundary is simulated. The gateway, redemption,
// request hash, platform identity, receipts and application remain real.
const servers = createProxyApps(config, {
  fetchFn: simulator.fetchFn,
  lookup: async hostname => {
    if (hostname !== 'chatgpt.com') throw new Error('fixture_dns_operation_denied')
    // No socket connects to this synthetic DNS result. The test fetch seam
    // serves Responses in memory while the unchanged origin policy executes.
    return [{ address: '104.18.32.47', family: 4 }]
  },
})
// The production probe app ends in a 404 catch-all, so a route appended to it
// is unreachable. The evidence route is registered first on a wrapper app that
// then delegates every other probe path to the unchanged production probe app.
const probeApp = express()
probeApp.get('/approved-tools/evidence', (_req, res) => res.json(simulator.evidence()))
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
