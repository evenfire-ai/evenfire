import electronPath from 'electron'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  configFile: path.join(packageRoot, 'ui/vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: false },
})

try {
  await server.listen()
  // Keep native fixture data outside the renderer bundle and derive it from
  // the same pure producers used by the operator route and renderer mapping.
  // The full GfsClient fixture helper imports Electron-bound app config, which
  // cannot run in this Node-side harness.
  const [treeProducer, affordanceProducer] = await Promise.all([
    server.ssrLoadModule(path.resolve(packageRoot, '../control-api/src/gfs/tree.ts')),
    server.ssrLoadModule(path.resolve(packageRoot, '../desktop-app/src/gfs/delegation.ts')),
  ])
  const resourceId = 'abababab-abab-4bab-8bab-abababababab'
  const page = await treeProducer.listChildrenPaged(
    {
      listChildren: async () => [
        {
          resourceId,
          name: 'native-menu-file.md',
          kind: 'file',
          pathCache: '/native-menu-file.md',
          bytes: 4,
          version: 1,
          updatedAt: '2026-11-13T00:00:00.000Z',
        },
      ],
    },
    'main',
    'native-root-resource',
    {}
  )
  const gfsFixture = {
    // This is control-api/src/routes/external/gfs.ts's operator-list response
    // projection over listChildrenPaged, crossing the Electron IPC clone.
    accessiblePage: structuredClone({
      ...page,
      rootResourceId: 'native-root-resource',
      view: 'operator',
    }),
    affordances: structuredClone(
      affordanceProducer.delegationAffordances(new Set(['read', 'manage_acl', 'write']), true)
    ),
  }
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a TCP port')
  const childEnvironment = {
    ...process.env,
    SIDEBAR_MENU_RENDERER_URL: `http://127.0.0.1:${address.port}/native-tests/sidebar-context-menu.html?fixture=${encodeURIComponent(JSON.stringify(gfsFixture))}`,
  }
  delete childEnvironment.ELECTRON_RUN_AS_NODE

  const child = spawn(electronPath, ['./test/native/sidebar-context-menu.fixture.cjs'], {
    cwd: packageRoot,
    env: childEnvironment,
    stdio: 'inherit',
  })
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
  process.exitCode = exitCode
} finally {
  await server.close()
}
