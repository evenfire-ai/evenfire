/**
 * Test-only external Grok/Codex Responses peers. Load with --import only in the
 * inspected derived proxy runtime; Desktop, IPC, RPC, Host, authorization and PG
 * remain real. No expected answers, image registry or production endpoint override.
 * E2E_GUARDIAN_IPC_FLOW: fixture observes the external end of the Desktop IPC journey.
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { decodeTileChallenge, requirePixelRenderer } from './subscription-image-challenge.cjs'

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
    const latest = messages.findLast(item => item.role === 'user')
    const prompt = latest?.content.filter(part => part.type === 'input_text').map(part => part.text).join('\n') ?? ''
    const receiptId = prompt.match(/Receipt: ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i)?.[1]
    if (!receiptId) return reject('image_receipt_missing')
    const parts = messages.flatMap(item => item.content).filter(part => part?.type === 'input_image')
    if (parts.length > 20) return reject('image_count_exceeded')
    const images = []
    let totalBytes = 0
    for (const part of parts) {
      const matched = typeof part.image_url === 'string' && part.image_url.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/)
      if (!matched) return reject('image_wire_invalid')
      const bytes = Buffer.from(matched[2], 'base64')
      totalBytes += bytes.length
      if (totalBytes > 20 * 1024 * 1024 || bytes.toString('base64') !== matched[2]) return reject('image_wire_invalid')
      images.push({ bytes, mimeType: matched[1] })
    }
    const row = { sequence: attempts.length + 1, provider, model: body.model, receiptId,
      imageSha256: images.map(image => sha256(image.bytes)), mimeTypes: images.map(image => image.mimeType),
      requestSha256: sha256(init.body), responseKind: 'rejected' }
    let output
    if (body.model !== binding.modelId || (body.model === binding.unsupportedModelId && images.length)) {
      attempts.push(row); record(snapshot()); return reject('image_model_unsupported')
    }
    try {
      output = images.length
        ? (await Promise.all(images.map(image => decodeTileChallenge(image.bytes)))).join('\n')
        : `TEXT_RECEIPT:${receiptId}`
    } catch {
      attempts.push(row); record(snapshot()); return reject('image_challenge_unreadable')
    }
    if (init.signal?.aborted) throw init.signal.reason
    row.responseKind = images.length ? 'pixels' : 'text'
    row.outputSha256 = sha256(output)
    attempts.push(row)
    record(snapshot())
    const events = [
      { type: 'response.output_text.delta', delta: output },
      { type: 'response.completed', response: { status: 'completed' } },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
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
