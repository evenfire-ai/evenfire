// This service owns the app import; the parent supplies synthetic configuration only.
import { createApp } from '../../dist/app.js'

const server = createApp().listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No loopback address')
  process.stdout.write(`http://127.0.0.1:${address.port}\n`)
})
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  const deadline = setTimeout(() => process.exit(1), 3000)
  server.closeAllConnections()
  server.close(error => {
    clearTimeout(deadline)
    process.exit(error ? 1 : 0)
  })
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
process.stdin.resume()
process.stdin.once('end', stop)
server.once('error', () => process.exit(1))
