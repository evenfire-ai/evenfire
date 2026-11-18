// Bundles the TypeScript fixture (it imports src/ and testSupport/, which tsc
// does not emit) next to the built main process, then runs it in real Electron.
// Expects `npm run build:main` first: the windows load dist/preload.js.
import electronPath from 'electron'
import * as esbuild from 'esbuild'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outfile = 'dist/native/gfs-watch-ipc.fixture.cjs'
await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['test/native/gfs-watch-ipc.fixture.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
})

const childEnvironment = { ...process.env }
delete childEnvironment.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, [outfile], {
  cwd: root,
  env: childEnvironment,
  stdio: 'inherit',
})
child.on('error', error => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', code => {
  process.exitCode = code ?? 1
})
