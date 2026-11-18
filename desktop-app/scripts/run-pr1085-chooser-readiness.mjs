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
  const env = {
    ...process.env,
    PR1085_CHOOSER_URL: `http://127.0.0.1:${address.port}/native-tests/pr1085-chooser-readiness.html`,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, ['./test/native/pr1085-chooser-readiness.fixture.cjs'], {
    cwd: packageRoot,
    env,
    stdio: 'inherit',
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
} finally {
  await server.close()
}
