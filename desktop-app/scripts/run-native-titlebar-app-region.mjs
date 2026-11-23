// Bundles the renderer harness (real WindowTitleBar + leading actions) for the
// browser, then runs the app-region fixture in real Electron, whose Chromium
// decides how `-webkit-app-region` is computed and inherited.
import electronPath from 'electron'
import * as esbuild from 'esbuild'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['ui/src/test/TitlebarAppRegionHarness.tsx'],
  outfile: 'dist/native/titlebar-app-region.harness.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})

const childEnvironment = { ...process.env }
delete childEnvironment.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, ['./test/native/titlebar-app-region.fixture.cjs'], {
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
