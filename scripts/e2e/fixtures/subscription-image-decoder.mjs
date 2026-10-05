// E2E_GUARDIAN_IPC_FLOW: pure native codec child for private fixture bytes; no renderer transition.
// Pure test-only native decoder boundary. It installs no vendor hooks and
// never imports login, seeding, runtime mutation or external service modules.
import { spawn } from 'node:child_process'

// The native image loader can fault on a truncated PNG/JPEG container. Reject
// known-incomplete bytes before it is invoked so a malformed tool image remains
// a bounded HTTP source failure instead of crashing the inspected runtime.
export function hasCompleteImageContainer(bytes, mimeType) {
  if (mimeType === 'image/png') {
    return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ])) && bytes.subarray(-12, -8).equals(Buffer.from([0, 0, 0, 0])) &&
      bytes.subarray(-8).equals(Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]))
  }
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
}

// A malformed image can SIGSEGV @napi-rs/canvas directly in the fixture PID
// (reproduced with an eight-byte PNG). Valid 20-image series do not crash the
// addon, so the causal boundary is malformed input, not cumulative decoder use.
// Decode each received image in a throwaway process with empty env, no shell,
// a fixed timeout, and bounded stdin/stdout. The vendor itself remains the
// long-lived state machine and keeps all attempt state in its own PID.
export const DECODER_TIMEOUT_MS = 10_000
const MAX_DECODER_STDOUT_BYTES = 1024 * 1024

function decoderChildScript() {
  const decoderUrl = new URL('./subscription-image-challenge.cjs', import.meta.url).href
  return `
import { decodeTileChallenge, requirePixelRenderer } from ${JSON.stringify(decoderUrl)}
const chunks = []
let byteLength = 0
for await (const chunk of process.stdin) {
  byteLength += chunk.length
  if (byteLength > 20 * 1024 * 1024) throw new Error('decoder input bound exceeded')
  chunks.push(chunk)
}
const bytes = Buffer.concat(chunks)
const native = requirePixelRenderer()
const image = await native.loadImage(bytes)
const code = await decodeTileChallenge(bytes)
if (!Number.isSafeInteger(image.width) || image.width < 1 ||
    !Number.isSafeInteger(image.height) || image.height < 1 ||
    !/^[A-F0-9]{16}$/.test(code)) throw new Error('invalid decoder result')
process.stdout.write(JSON.stringify({ width: image.width, height: image.height, code }))
`
}

export function decodeInChild(bytes, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', decoderChildScript()], {
      cwd: '/',
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    let stdoutBytes = 0
    const stderr = []
    let stderrBytes = 0
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(error)
    }
    const abort = () => child.kill('SIGKILL')
    const timer = setTimeout(() => child.kill('SIGKILL'), DECODER_TIMEOUT_MS)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= MAX_DECODER_STDOUT_BYTES) stdout.push(chunk)
    })
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length
      if (stderrBytes <= 64 * 1024) stderr.push(chunk)
    })
    child.on('error', fail)
    child.on('close', (code, receivedSignal) => {
      try {
        if (settled) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (code !== 0) throw new Error(`image decoder exited with ${code ?? receivedSignal}`)
        if (stdoutBytes > MAX_DECODER_STDOUT_BYTES) throw new Error('image decoder output bound exceeded')
        const result = JSON.parse(Buffer.concat(stdout).toString('utf8'))
        if (!Number.isSafeInteger(result.width) || result.width < 1 ||
            !Number.isSafeInteger(result.height) || result.height < 1 ||
            !/^[A-F0-9]{16}$/.test(result.code)) throw new Error('image decoder result invalid')
        settled = true
        resolve({ width: result.width, height: result.height, code: result.code })
      } catch (error) {
        fail(error)
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(bytes)
  })
}
