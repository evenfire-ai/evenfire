// This file is copied only into the isolated Minikube E2E image.
if (
  process.env.CODEX_APPROVED_TOOLS_TEST_ONLY !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  !/^[a-z0-9][a-z0-9-]+$/.test(process.env.CODEX_APPROVED_TOOLS_MINIKUBE_PROFILE || '') ||
  !process.env.KUBERNETES_SERVICE_HOST
) {
  throw new Error('approved-tools proxy requires explicit isolated Minikube test markers')
}
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
servers.probeApp.get('/approved-tools/evidence', (_req, res) => res.json(simulator.evidence()))
servers.runtime.listen(config.runtimePort)
servers.admin.listen(config.adminPort)
servers.probe.listen(config.probePort)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => void servers.close().then(() => process.exit(0)))
}
