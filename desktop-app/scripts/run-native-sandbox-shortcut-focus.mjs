import electronPath from 'electron'
import { spawn } from 'node:child_process'

const childEnvironment = { ...process.env }
delete childEnvironment.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, ['./test/native/sandbox-shortcut-focus.fixture.cjs'], {
  cwd: new URL('..', import.meta.url),
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
