#!/usr/bin/env node
// Cleanup requests stay in the enclosing gate's process group so they cannot
// outlive its final SIGKILL and mutation lease.
import { spawn } from 'node:child_process'

const [rawSeconds, command, ...args] = process.argv.slice(2)
if (!/^[1-9][0-9]*$/.test(rawSeconds ?? '') || Number(rawSeconds) > 270 || !command) {
  process.stderr.write('cleanup command requires a deadline from 1 to 270 seconds and a command\n')
  process.exit(2)
}
const child = spawn(command, args, { detached: false, stdio: 'inherit', env: process.env })
let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  // Kill only this directly owned request. Descendants remain in the outer
  // deadline runner's process group for final reaping.
  child.kill('SIGKILL')
}, Number(rawSeconds) * 1000)
child.once('error', error => {
  clearTimeout(timer)
  process.stderr.write(`cleanup command failed to start: ${error.code ?? 'unknown'}\n`)
  process.exitCode = error.code === 'ENOENT' ? 127 : 126
})
child.once('exit', (code, signal) => {
  clearTimeout(timer)
  process.exitCode = timedOut ? 124 : (code ?? (signal ? 1 : 0))
})
