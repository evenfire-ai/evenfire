// E2E_GUARDIAN_IPC_FLOW: test-controller transport only. The server clicks the
// already-owned DOM button; no product API or renderer HTTP route is called.
import { lstatSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
let directoryPath
if (process.platform === 'win32') {
  const match = /^\\\\\.\\pipe\\evenfire-gfs-review-([0-9a-f-]{36})$/i.exec(socketPath)
  if (!match) throw new Error('Private reviewer pipe required')
  directoryPath = join(tmpdir(), `gfs-review-${match[1]}`)
} else {
  const socket = lstatSync(socketPath)
  directoryPath = dirname(socketPath)
  const directory = lstatSync(directoryPath)
  if (
    !socket.isSocket() ||
    (socket.mode & 0o777) !== 0o600 ||
    socket.uid !== process.getuid?.() ||
    !directory.isDirectory() ||
    (directory.mode & 0o777) !== 0o700 ||
    directory.uid !== socket.uid
  )
    throw new Error('Private reviewer socket required')
}
const controlDirectoryPath = join(directoryPath, 'sessions')
const controlDirectory = lstatSync(controlDirectoryPath)
const accessTokenPath = join(controlDirectoryPath, 'review-token')
const accessTokenFile = lstatSync(accessTokenPath)
if (
  !controlDirectory.isDirectory() ||
  !accessTokenFile.isFile() ||
  accessTokenFile.nlink !== 1 ||
  (process.platform !== 'win32' &&
    ((controlDirectory.mode & 0o777) !== 0o700 ||
      controlDirectory.uid !== process.getuid?.() ||
      (accessTokenFile.mode & 0o777) !== 0o600 ||
      accessTokenFile.uid !== controlDirectory.uid))
)
  throw new Error('Private reviewer authorization file required')
const accessToken = readFileSync(accessTokenPath, 'utf8')
if (!/^[0-9a-f]{64}$/i.test(accessToken)) throw new Error('Invalid reviewer authorization file')
const socket = connect(socketPath)
socket.setTimeout(5_000, () => socket.destroy(new Error('Reviewer socket deadline exceeded')))
let bytes = Buffer.alloc(0)
socket.on('connect', () =>
  socket.write(`${JSON.stringify({ action, ...(nonce ? { nonce } : {}), accessToken })}\n`)
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
