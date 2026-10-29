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
const { createRealHybridUpstream } = await import('./test/realHybridUpstream.ts')
const hybrid = process.env.APPROVED_TOOLS_UPSTREAM_MODE === 'real-hybrid'
if (hybrid && process.env.CODEX_REAL_UPSTREAM_CONFIRM !== '1')
  throw new Error('Real subscription use requires explicit confirmation')
const upstream = hybrid ? createRealHybridUpstream(globalThis.fetch) : createApprovedToolsUpstream()
const config = loadConfig()
// Only the external model boundary is controlled. Hybrid forwards every
// request except one post-tool completion through the real Codex subscription.
const servers = createProxyApps(config, {
  fetchFn: upstream.fetchFn,
  ...(!hybrid && {
    lookup: async hostname => {
      if (hostname !== 'chatgpt.com') throw new Error('fixture_dns_operation_denied')
      // Deterministic Responses stay in memory while origin policy executes.
      return [{ address: '104.18.32.47', family: 4 }]
    },
  }),
})
// The production probe app ends in a 404 catch-all, so a route appended to it
// is unreachable. The evidence route is registered first on a wrapper app that
// then delegates every other probe path to the unchanged production probe app.
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
