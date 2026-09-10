import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Development-only: no external network, published ports, or credential mounts.
if (process.versions.node.split('.')[0] !== '24') throw new Error('Use Node 24 for network tests')
const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const image =
  process.argv[2] === '--image' && process.argv.length === 4 ? process.argv[3] : undefined
if (process.argv.length > 2 && !image)
  throw new Error('Usage: run-network.mjs [--image local-image-id]')
const endpoint =
  process.env.DOCKER_HOST ||
  execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
    encoding: 'utf8',
    timeout: 10000,
  }).trim()
if (
  !endpoint.startsWith('unix:///') &&
  !/^tcp:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(endpoint)
)
  throw new Error('A local Docker endpoint is required')
const config = mkdtempSync(path.join(tmpdir(), 'issue198-docker-'))
// Synthetic, one-day certificate generated locally, never committed.
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    path.join(config, 'fixture-key.pem'),
    '-out',
    path.join(config, 'fixture-cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=fixture.test',
    '-addext',
    'subjectAltName=DNS:fixture.test,DNS:rebind.test,IP:11.198.0.2',
  ],
  { stdio: 'ignore', timeout: 10000 }
)
const name = 'issue198-network-' + randomUUID()
const docker = ['--host', endpoint, '--config', config]
const args = [
  ...docker,
  'run',
  '--rm',
  '--pull=never',
  '--name',
  name,
  '--network=none',
  '--cap-drop=ALL',
  '--cap-add=NET_ADMIN',
  '--memory=256m',
  '--cpus=1',
  '--label',
  'evenfire.test=issue198-network',
  '--mount',
  `type=bind,src=${config},dst=/fixture-tls,readonly`,
  '-e',
  'NODE_EXTRA_CA_CERTS=/fixture-tls/fixture-cert.pem',
]
for (const part of image ? ['test'] : ['dist', 'node_modules', 'test'])
  args.push(
    '--mount',
    `type=bind,src=${realpathSync(path.join(root, part))},dst=/app/${part},readonly`
  )
args.push(
  image ?? 'node:24-alpine',
  'sh',
  '-ec',
  'ip addr add 11.198.0.2/32 dev lo; test -z "$(ip route show default)"; printf "nameserver 127.0.0.1\\n" > /etc/resolv.conf; node --test /app/test/mcp.network.mjs'
)
let child
let timeout
let interrupted = false
const stop = () => {
  interrupted = true
  child?.kill('SIGTERM')
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  child = spawn('docker', args, { stdio: 'inherit' })
  timeout = setTimeout(stop, 60000)
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  process.exitCode = interrupted || status !== 0 ? 1 : 0
} finally {
  clearTimeout(timeout)
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  // Random name belongs exclusively to this invocation, including on timeout.
  try {
    execFileSync('docker', [...docker, 'rm', '-f', name], { stdio: 'ignore', timeout: 10000 })
  } catch {
    // --rm may already have removed it. Prove absence; a Docker failure is not cleanup.
    try {
      const remaining = execFileSync(
        'docker',
        [...docker, 'ps', '-aq', '--filter', `name=^/${name}$`],
        { encoding: 'utf8', timeout: 10000 }
      ).trim()
      if (remaining) throw new Error('The test container remains after cleanup')
    } catch {
      process.exitCode = 1
      console.error('Could not verify removal of the isolated test container')
    }
  }
  rmSync(config, { recursive: true, force: true })
}
