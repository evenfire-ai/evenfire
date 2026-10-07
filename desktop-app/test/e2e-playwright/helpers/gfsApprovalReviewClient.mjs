// E2E_GUARDIAN_IPC_FLOW: test-controller transport only. The server clicks the
// already-owned DOM button; no product API or renderer HTTP route is called.
import { lstatSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname } from 'node:path'

const [socketPath, action, nonce] = process.argv.slice(2)
if (
  !socketPath ||
  !['view', 'approve', 'deny', 'release'].includes(action) ||
  process.argv.length !== (action === 'approve' || action === 'deny' ? 5 : 4) ||
  ((action === 'approve' || action === 'deny') && !/^[0-9a-f-]{36}$/.test(nonce ?? ''))
) {
  throw new Error(
    'Usage: node gfsApprovalReviewClient.mjs SOCKET view|release|approve NONCE|deny NONCE'
  )
}
const info = lstatSync(socketPath)
const directory = lstatSync(dirname(socketPath))
if (
  !info.isSocket() ||
  (info.mode & 0o777) !== 0o600 ||
  info.uid !== process.getuid?.() ||
  !directory.isDirectory() ||
  (directory.mode & 0o777) !== 0o700 ||
  directory.uid !== info.uid
)
  throw new Error('Private reviewer socket required')
const socket = connect(socketPath)
socket.setTimeout(5_000, () => socket.destroy(new Error('Reviewer socket deadline exceeded')))
let bytes = Buffer.alloc(0)
socket.on('connect', () =>
  socket.write(`${JSON.stringify({ action, ...(nonce ? { nonce } : {}) })}\n`)
)
socket.on('data', chunk => {
  if (bytes.length + chunk.length > 100_000)
    return socket.destroy(new Error('Review response exceeds byte bound'))
  bytes = Buffer.concat([bytes, chunk])
})
socket.on('end', () => {
  const response = JSON.parse(bytes.toString('utf8'))
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`)
  if (response.error) process.exitCode = 1
})
socket.on('error', error => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
