import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test(
  'network runner escalates cancellation and cleans its exact container',
  { timeout: 25000 },
  async () => {
    const runner = fileURLToPath(new URL('./run-network.mjs', import.meta.url))
    const probe = mkdtempSync(path.join(tmpdir(), 'pr608-runner-'))
    const fake = path.join(probe, 'docker')
    writeFileSync(
      fake,
      `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.PR608_PROBE_DIR;
const args = process.argv.slice(2);
if (args.includes('run')) {
  const name = args[args.indexOf('--name')+1];
  process.on('SIGTERM',()=>{});
  setInterval(()=>{},1000);
  fs.writeFileSync(dir+'/running.json', JSON.stringify({name,pid:process.pid})); // Deliberately unresponsive external CLI fixture.
} else if (args.includes('rm')) {
  fs.writeFileSync(dir+'/removed.txt',args.at(-1));
} else if (args.includes('ps')) {
  process.exit(0);
} else process.exit(2);
`,
      { mode: 0o755 }
    )
    const child = spawn(process.execPath, [runner], {
      env: {
        PATH: probe + ':' + path.dirname(process.execPath) + ':/usr/bin:/bin',
        DOCKER_HOST: 'unix:///tmp/pr608-unused.sock',
        PR608_PROBE_DIR: probe,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => (output += chunk))
    child.stderr.on('data', chunk => (output += chunk))
    let fakePid
    try {
      await new Promise((resolve, reject) => {
        const limit = setTimeout(() => {
          clearInterval(poll)
          reject(new Error('fake CLI not reached: ' + output))
        }, 15000)
        const poll = setInterval(() => {
          if (existsSync(path.join(probe, 'running.json'))) {
            clearInterval(poll)
            clearTimeout(limit)
            resolve()
          }
        }, 10)
      })
      const started = JSON.parse(readFileSync(path.join(probe, 'running.json'), 'utf8'))
      fakePid = started.pid
      const start = performance.now()
      child.kill('SIGTERM')
      const code = await new Promise((resolve, reject) => {
        const limit = setTimeout(
          () => reject(new Error('runner did not stop within 8 seconds')),
          8000
        )
        child.once('exit', code => {
          clearTimeout(limit)
          resolve(code)
        })
      })
      assert.notEqual(code, 0)
      assert.equal(readFileSync(path.join(probe, 'removed.txt'), 'utf8'), started.name)
      assert.throws(() => process.kill(fakePid, 0), { code: 'ESRCH' })
      console.log(
        'RUNNER_CANCELLATION_CLEANUP_PASS elapsedMs=' + Math.round(performance.now() - start)
      )
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      if (fakePid) {
        try {
          const command = execFileSync('ps', ['-ww', '-p', String(fakePid), '-o', 'command='], {
            encoding: 'utf8',
          })
          if (command.includes(fake)) process.kill(fakePid, 'SIGKILL')
        } catch {}
      }
      rmSync(probe, { recursive: true, force: true })
    }
  }
)
