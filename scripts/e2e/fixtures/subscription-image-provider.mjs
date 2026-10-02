/**
 * Test-only external Grok/Codex Responses peers. Load with --import only in the
 * inspected derived proxy runtime; Desktop, IPC, RPC, Host, authorization and PG
 * remain real. No expected answers, image registry or production endpoint override.
 * E2E_GUARDIAN_IPC_FLOW: fixture observes the external end of the Desktop IPC journey.
 */
import { createHash, randomUUID } from 'node:crypto'
import { deepStrictEqual } from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { requirePixelRenderer } from './subscription-image-challenge.cjs'

const require = createRequire(import.meta.url)
const grok = require('../../../packages/grok-provider-attempt-contract/index.cjs')
export const SUBSCRIPTION_VENDOR_URLS = {
  'grok-subscription': { responses: grok.COMPLETIONS_ORIGIN, catalog: grok.CATALOG_ORIGIN },
  'codex-subscription': {
    responses: 'https://chatgpt.com/backend-api/codex/responses',
    catalog: 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
  },
}
const sha256 = value => createHash('sha256').update(value).digest('hex')
const reject = code => new Response(JSON.stringify({ error: { code } }), { status: 422, headers: { 'content-type': 'application/json' } })
const sseResponse = events => new Response(
  events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
)
const same = (left, right) => {
  try {
    deepStrictEqual(left, right)
    return true
  } catch {
    return false
  }
}

// The native image loader can fault on a truncated PNG/JPEG container. Reject
// known-incomplete bytes before it is invoked so a malformed tool image remains
// a bounded HTTP source failure instead of crashing the inspected runtime.
function hasCompleteImageContainer(bytes, mimeType) {
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
const DECODER_TIMEOUT_MS = 10_000
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

function decodeInChild(bytes, signal) {
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

function wireText(item) {
  if (typeof item?.content === 'string') return item.content
  if (!Array.isArray(item?.content)) return ''
  return item.content.filter(part => part?.type === 'input_text').map(part => part.text).join('\n')
}

function wireImages(body) {
  if (!Array.isArray(body.input)) return []
  return body.input.flatMap(item => {
    if (!Array.isArray(item?.content)) return []
    return item.content.filter(part => part?.type === 'input_image').map(part => {
      const matched = typeof part.image_url === 'string' &&
        part.image_url.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/)
      if (!matched) return { invalid: true }
      const bytes = Buffer.from(matched[2], 'base64')
      if (bytes.toString('base64') !== matched[2]) return { invalid: true }
      return { bytes, mimeType: matched[1] }
    })
  })
}

function parseReferencedFiles(text) {
  const pattern = /referenced_file: id="gfs:([^":\s]+):([a-f0-9]{32})@v(\d+)".*?drive="\1" resourceId="\2" version=\3 .*?bytes=(\d+) availability=available(?:\s|$)/g
  return Array.from(text.matchAll(pattern), ([, drive, resourceId, version, byteLength]) => ({
    referenceId: `gfs:${drive}:${resourceId}@v${version}`,
    drive,
    resourceId,
    version: Number(version),
    availability: 'available',
    byteLength: Number(byteLength),
  }))
}

function readNativeToolCalls(body, userIndex) {
  const calls = body.input.slice(userIndex + 1).filter(item => item?.type === 'function_call')
  const outputs = body.input.slice(userIndex + 1).filter(item => item?.type === 'function_call_output')
  const outputByCall = new Map()
  const argumentsByCall = new Map()
  if (new Set(calls.map(call => call.call_id)).size !== calls.length ||
      calls.some(call => typeof call.call_id !== 'string' || !call.call_id ||
        typeof call.name !== 'string' || typeof call.arguments !== 'string')) {
    return { error: 'tool_wire_invalid' }
  }
  try {
    for (const call of calls) {
      const parsed = JSON.parse(call.arguments)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      argumentsByCall.set(call.call_id, parsed)
    }
    for (const output of outputs) {
      if (typeof output.call_id !== 'string' || typeof output.output !== 'string' ||
          !argumentsByCall.has(output.call_id) || outputByCall.has(output.call_id)) {
        throw new Error('unpaired output')
      }
      outputByCall.set(output.call_id, output)
    }
  } catch {
    return { error: 'tool_wire_invalid' }
  }
  return { calls, outputByCall, argumentsByCall }
}

function functionCallEvents(callId, name, rawArguments, outputIndex = 0) {
  const itemId = `fc_${randomUUID().replaceAll('-', '')}`
  return [
    { type: 'response.output_item.added', output_index: outputIndex, item: {
      id: itemId, type: 'function_call', call_id: callId, name, arguments: '',
    } },
    { type: 'response.function_call_arguments.delta', item_id: itemId, delta: rawArguments },
    { type: 'response.function_call_arguments.done', item_id: itemId, arguments: rawArguments },
    { type: 'response.completed', response: { status: 'completed' } },
  ]
}

const ledgerCalls = calls => calls.map(call => ({
  id: call.call_id,
  name: call.name,
  argumentsSha256: sha256(call.arguments),
}))

const ledgerOutputs = (calls, outputByCall, resources = new Map()) => calls.map(call => ({
  id: call.call_id,
  outputSha256: sha256(outputByCall.get(call.call_id)?.output ?? ''),
  ...(resources.has(call.call_id) ? { resource: resources.get(call.call_id) } : {}),
}))

const proposedCall = (name, argumentsValue) => {
  const rawArguments = JSON.stringify(argumentsValue)
  return {
    call: { call_id: `call_${randomUUID().replaceAll('-', '')}`, name, arguments: rawArguments },
    rawArguments,
  }
}

export function createSubscriptionImageVendor({ runId, bindings, acceptedProvider, maxAttempts = 256, record = () => {} }) {
  if (!/^subscription-image-[a-f0-9]{12}$/.test(runId) || !Array.isArray(bindings) || bindings.length !== 2 ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 1024) throw new Error('Invalid external vendor fixture binding')
  for (const provider of Object.keys(SUBSCRIPTION_VENDOR_URLS)) {
    const binding = bindings.find(item => item.provider === provider)
    if (!binding || !binding.modelId || !binding.unsupportedModelId || binding.modelId === binding.unsupportedModelId) {
      throw new Error('External vendor fixture requires distinct exact model bindings')
    }
  }
  requirePixelRenderer()
  const attempts = []
  const snapshot = () => ({ kind: 'evenfire-subscription-image-vendor-v1', runId, attempts: structuredClone(attempts) })
  async function respond(rawUrl, init = {}) {
    const provider = Object.keys(SUBSCRIPTION_VENDOR_URLS).find(name => Object.values(SUBSCRIPTION_VENDOR_URLS[name]).includes(rawUrl))
    if (!provider || (acceptedProvider && provider !== acceptedProvider)) throw new Error('Request is outside the exact external vendor boundary')
    const binding = bindings.find(item => item.provider === provider)
    if (rawUrl === SUBSCRIPTION_VENDOR_URLS[provider].catalog) {
      if ((init.method ?? 'GET') !== 'GET') throw new Error('Invalid external catalog method')
      // Synthetic catalogue identities are caller-bound; capability evidence is
      // still owned by the real Host/Control API projection, not this fixture.
      return Response.json({ models: [binding.modelId, binding.unsupportedModelId].map(model => ({ model })) })
    }
    if (init.method !== 'POST' || typeof init.body !== 'string' || Buffer.byteLength(init.body) > 36 * 1024 * 1024) {
      throw new Error('External fixture Responses body or method is invalid')
    }
    if (attempts.length >= maxAttempts) throw new Error('External fixture evidence bound exceeded')
    if (init.signal?.aborted) throw init.signal.reason
    const body = JSON.parse(init.body)
    if (!Array.isArray(body.input)) return reject('image_input_missing')

    const messages = body.input.filter(item => item && Array.isArray(item.content))
    const markedIndex = messages.findLastIndex(item => item.role === 'user' &&
      /Journey: (?:tool-screenshot|gfs-image)(?:\n|$)/.test(wireText(item)))
    const marked = messages[markedIndex]
    const prompt = wireText(marked ?? messages.findLast(item => item.role === 'user'))
    const receiptId = prompt.match(/Receipt: ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i)?.[1]
    if (!receiptId) return reject('image_receipt_missing')

    const images = wireImages(body)
    if (images.length > 20) return reject('image_count_exceeded')
    if (images.some(part => part.invalid)) return reject('image_wire_invalid')
    if (images.some(part => !hasCompleteImageContainer(part.bytes, part.mimeType))) {
      return reject('image_challenge_unreadable')
    }
    let totalBytes = 0
    for (const part of images) {
      totalBytes += part.bytes.length
      if (totalBytes > 20 * 1024 * 1024) return reject('image_count_exceeded')
    }
    const journey = prompt.match(/Journey: (tool-screenshot|gfs-image)(?:\n|$)/)?.[1]
    const tool = readNativeToolCalls(body, marked ? body.input.indexOf(marked) : -1)
    if (tool.error) return reject(tool.error)
    if (tool.calls.length > 0 && !journey) return reject('journey_marker_missing')
    if (journey && markedIndex !== messages.length - 1 && images.length === 0) {
      return reject('journey_marker_not_last_real_user')
    }

    const row = { sequence: attempts.length + 1, provider, model: body.model, receiptId,
      imageSha256: images.map(image => sha256(image.bytes)), mimeTypes: images.map(image => image.mimeType),
      receivedImageDigests: images.map(image => sha256(image.bytes)),
      receivedImageOrder: images.map(image => sha256(image.bytes)),
      decodedPixels: [], requestSha256: sha256(init.body), responseKind: 'rejected' }
    let proposedEvents
    if (body.model !== binding.modelId || (body.model === binding.unsupportedModelId && images.length)) {
      attempts.push(row); record(snapshot()); return reject('image_model_unsupported')
    }

    if (journey === 'tool-screenshot') {
      const imagePath = prompt.match(/Screen fixture: (\S+)/)?.[1]
      const regionMatch = prompt.match(/^Screenshot region: (\{.*\})$/m)?.[1]
      let region
      try {
        region = JSON.parse(regionMatch ?? '')
      } catch {
        region = null
      }
      const pending = tool.calls.filter(call => !tool.outputByCall.has(call.call_id))
      if (!imagePath || !region || tool.calls.length > 2 || pending.length > 1) {
        attempts.push(row); record(snapshot()); return reject('tool_state_invalid')
      }
      row.journey = journey
      row.stage = tool.calls.length === 0 ? 'prepare' : (pending.length > 0 ? 'capture' : 'pixels')
      row.toolOutputs = ledgerOutputs(tool.calls, tool.outputByCall)
      if (tool.calls.length === 0) {
        const shell = proposedCall('shell_exec', { command: `test -r ${imagePath}` })
        row.toolCalls = ledgerCalls([shell.call])
        proposedEvents = functionCallEvents(shell.call.call_id, shell.call.name, shell.rawArguments)
      } else {
        const [shell, screenshot] = tool.calls
        if (shell.name !== 'shell_exec' ||
            !same(tool.argumentsByCall.get(shell.call_id), { command: `test -r ${imagePath}` }) ||
            tool.outputByCall.get(shell.call_id)?.output !== '(no output)') {
          attempts.push(row); record(snapshot()); return reject('tool_source_invalid')
        }
        if (pending.length > 0) {
          if (screenshot.name !== 'desktop_screenshot' ||
              !same(tool.argumentsByCall.get(screenshot.call_id), { region })) {
            attempts.push(row); record(snapshot()); return reject('tool_source_invalid')
          }
          row.toolCalls = ledgerCalls([screenshot])
          proposedEvents = functionCallEvents(
            screenshot.call_id,
            screenshot.name,
            JSON.stringify(tool.argumentsByCall.get(screenshot.call_id)),
          )
        } else {
          if (screenshot.name !== 'desktop_screenshot' ||
              !same(tool.argumentsByCall.get(screenshot.call_id), { region }) ||
              images.length !== 1) {
            attempts.push(row); record(snapshot()); return reject('tool_source_invalid')
          }
        }
      }
    } else if (journey === 'gfs-image') {
      const references = parseReferencedFiles(String(body.instructions ?? ''))
      const userReferences = parseReferencedFiles(wireText(marked))
      if (references.length !== 2 || !same(references, userReferences)) {
        attempts.push(row); record(snapshot()); return reject('referenced_files_invalid')
      }
      row.journey = journey
      row.referencedFiles = references
      const pending = tool.calls.filter(call => !tool.outputByCall.has(call.call_id))
      if (tool.calls.length === 0) {
        row.stage = 'read'
        row.toolCalls = []
        proposedEvents = []
        for (const reference of references) {
          const read = proposedCall('clerum__gfs_read', {
            drive: reference.drive,
            resourceId: reference.resourceId,
            expectedVersion: reference.version,
          })
          row.toolCalls.push(...ledgerCalls([read.call]))
          proposedEvents.push(...functionCallEvents(
            read.call.call_id,
            read.call.name,
            read.rawArguments,
            row.toolCalls.length - 1,
          ))
        }
      } else {
        if (tool.calls.length !== 2 || pending.length > 0 || images.length !== 2) {
          attempts.push(row); record(snapshot()); return reject('tool_state_invalid')
        }
        row.stage = 'pixels'
        const resources = new Map()
        for (const [index, call] of tool.calls.entries()) {
          const reference = references[index]
          let outputValue
          try {
            outputValue = JSON.parse(tool.outputByCall.get(call.call_id).output)
          } catch {
            outputValue = null
          }
          const expectedResource = {
            kind: 'gfs',
            drive: reference.drive,
            resourceId: reference.resourceId,
            version: reference.version,
            gfsUri: `gfs://${reference.drive}/${reference.resourceId}`,
          }
          if (call.name !== 'clerum__gfs_read' ||
              !same(tool.argumentsByCall.get(call.call_id), {
                drive: reference.drive,
                resourceId: reference.resourceId,
                expectedVersion: reference.version,
              }) ||
              !same(outputValue?.resource, expectedResource) ||
              outputValue?.delivery !== 'image_input') {
            attempts.push(row); record(snapshot()); return reject('tool_source_invalid')
          }
          resources.set(call.call_id, outputValue.resource)
        }
        row.toolOutputs = ledgerOutputs(tool.calls, tool.outputByCall, resources)
      }
    }

    let output
    try {
      const decoded = []
      for (const image of images) decoded.push(await decodeInChild(image.bytes, init.signal))
      output = decoded.length ? decoded.map(result => result.code).join('\n') : `TEXT_RECEIPT:${receiptId}`
      row.decodedPixels = decoded.map(({ width, height }) => ({ width, height }))
    } catch {
      attempts.push(row); record(snapshot()); return reject('image_challenge_unreadable')
    }
    if (init.signal?.aborted) throw init.signal.reason
    row.responseKind = proposedEvents ? 'tool_calls' : (images.length ? 'pixels' : 'text')
    row.outputSha256 = sha256(output)
    attempts.push(row)
    record(snapshot())
    if (proposedEvents) return sseResponse(proposedEvents)
    return sseResponse([
      { type: 'response.output_text.delta', delta: output },
      { type: 'response.completed', response: { status: 'completed' } },
    ])
  }
  return { respond, snapshot }
}

/** Explicit derived-runtime hook. The caller owns restoration/image/lease proof. */
export function installSubscriptionImageVendor(env = process.env) {
  if (env.NODE_ENV !== 'test' || env.EVENFIRE_SUBSCRIPTION_IMAGE_VENDOR_FIXTURE !== '1') {
    throw new Error('External vendor fixture requires an explicitly derived test runtime')
  }
  const acceptedProvider = env.SUBSCRIPTION_IMAGE_FIXTURE_PROVIDER
  if (!Object.hasOwn(SUBSCRIPTION_VENDOR_URLS, acceptedProvider ?? '')) throw new Error('External vendor fixture requires its physical proxy provider binding')
  const evidencePath = env.SUBSCRIPTION_IMAGE_EVIDENCE_PATH
  if (!evidencePath || !path.isAbsolute(evidencePath) || fs.existsSync(evidencePath)) {
    throw new Error('External vendor evidence requires a fresh absolute path')
  }
  const parent = fs.statSync(path.dirname(evidencePath))
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
    throw new Error('External vendor evidence requires a private owned directory')
  }
  const bindings = ['GROK', 'CODEX'].map(kind => ({ provider: `${kind.toLowerCase()}-subscription`,
    modelId: env[`E2E_${kind}_IMAGE_MODEL`], unsupportedModelId: env[`E2E_${kind}_IMAGE_UNSUPPORTED_MODEL`] }))
  const vendor = createSubscriptionImageVendor({ runId: env.E2E_SUBSCRIPTION_IMAGE_RUN_ID, bindings, acceptedProvider,
    record: snapshot => {
      const temporary = `${evidencePath}.next`
      fs.writeFileSync(temporary, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, evidencePath)
    } })
  fs.writeFileSync(evidencePath, JSON.stringify(vendor.snapshot()), { flag: 'wx', mode: 0o600 })
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input)
    if (Object.values(SUBSCRIPTION_VENDOR_URLS).some(urls => Object.values(urls).includes(rawUrl))) {
      return vendor.respond(rawUrl, init)
    }
    // Core requests are passed through unchanged. Other vendor paths fail closed
    // so this deterministic lane cannot accidentally call a real vendor route.
    const url = new URL(rawUrl)
    if (Object.values(SUBSCRIPTION_VENDOR_URLS).some(urls => new URL(urls.responses).hostname === url.hostname)) {
      throw new Error('Request is outside the exact external vendor boundary')
    }
    return original(input, init)
  }
  return () => { globalThis.fetch = original }
}

if (process.env.EVENFIRE_SUBSCRIPTION_IMAGE_VENDOR_FIXTURE === '1') installSubscriptionImageVendor()
