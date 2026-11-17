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
  const address = server.httpServer.address()
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a TCP port')
  const childEnvironment = {
    ...process.env,
    SIDEBAR_MENU_RENDERER_URL: `http://127.0.0.1:${address.port}/native-tests/sidebar-context-menu.html`,
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
