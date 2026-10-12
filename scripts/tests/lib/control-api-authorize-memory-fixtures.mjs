/** Physical synthetic request shapes for the real HTTP/PG memory experiment. No runtime or credential access. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const grok = require('../../../packages/grok-provider-attempt-contract/index.cjs')
const codex = require('../../../packages/llm-provider-attempt-contract/index.cjs')
const imageContainers = require('../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs')
const nativeRequire = createRequire(new URL('../../../mcp-host/package.json', import.meta.url))
export const MIB = 1024 * 1024
export const SHAPES = ['visual-35mib', 'worst-structure', 'max-containers', 'max-members', 'max-elements', 'wide-strings']
export const sha256 = value => createHash('sha256').update(value).digest('hex')
let imageBase64
function physicalPng() {
  if (!imageBase64) {
    const { createCanvas } = nativeRequire('@napi-rs/canvas')
    const canvas = createCanvas(8, 8), context = canvas.getContext('2d')
    context.fillStyle = '#2480ca'; context.fillRect(0, 0, 8, 8)
    const bytes = imageContainers.padPngToSize(canvas.toBuffer('image/png'), grok.GROK_VISUAL_LIMITS.maxTotalImageBytes)
    imageBase64 = bytes.toString('base64')
  }
  return imageBase64
}
export function structureOf(root) {
  const pending = [[root, 1]]
  let containers = 0, members = 0, elements = 0, maxDepth = 0, arrayElements = 0
  while (pending.length) {
    const [value, depth] = pending.pop(); elements++
    if (!value || typeof value !== 'object') continue
    containers++; maxDepth = Math.max(maxDepth, depth)
    const values = Array.isArray(value) ? value : Object.values(value)
    if (Array.isArray(value)) arrayElements += values.length
    else members += Object.keys(value).length
    for (const child of values) pending.push([child, depth + 1])
  }
  return { containers, members, elements, arrayElements, maxDepth }
}
function stressTree(request, shape) {
  if (!['worst-structure', 'max-containers', 'max-members', 'max-elements'].includes(shape)) return
  const parameters = { type: 'object', properties: { stress: { type: 'array', items: {}, default: [] } } }
  request.tools = [{ name: 'memory_fixture_shape', description: 'Synthetic valid schema used only by the local memory experiment', parameters }]
  const values = parameters.properties.stress.default
  const base = structureOf(request)
  if (shape === 'max-members') {
    parameters.properties.stress.type = 'object'
    delete parameters.properties.stress.items
    parameters.properties.stress.default = {}
    const target = grok.LIMITS.maxRequestMembers - structureOf(request).members
    for (let index = 0; index < target; index++) parameters.properties.stress.default[`m${index}`] = 0
  } else if (shape === 'max-elements') {
    for (let index = 0; index < grok.LIMITS.maxRequestElements - base.elements; index++) values.push(0)
  } else {
    const count = grok.LIMITS.maxRequestContainers - base.containers
    for (let index = 0; index < count; index++) values.push({})
    if (shape === 'worst-structure') {
      const members = grok.LIMITS.maxRequestMembers - structureOf(request).members
      if (members > values.length) throw new Error('Fixture structure cannot reach member target')
      for (let index = 0; index < members; index++) values[index].a = 0
      const elements = grok.LIMITS.maxRequestElements - structureOf(request).elements
      for (let index = 0; index < elements; index++) values.push(0)
    }
  }
}
export function buildAuthorizeFixture({ shape, binding, invocationId, small = false }) {
  if (!SHAPES.includes(shape) || !binding?.policyHash || !Number.isSafeInteger(binding.policyRevision) || !/^[A-Za-z0-9-]{1,128}$/.test(invocationId)) throw new Error('Invalid physical fixture binding')
  const request = { schemaVersion: 'grok-completion-request.v2', requestId: invocationId, idempotencyKey: invocationId,
    provider: 'grok-subscription', model: 'grok-4.6', messages: [{ role: 'user', content: '', contentParts: [{ type: 'text', text: '' }] }] }
  if (!small) request.messages[0].contentParts.push({ type: 'image', mimeType: 'image/png', data: physicalPng(), source: { kind: 'tool', attachmentId: invocationId, toolCallId: invocationId } })
  stressTree(request, small ? 'visual-35mib' : shape)
  const envelope = { request, invocationId, attemptGeneration: 1, providerAttemptIndex: 1, policyRevision: binding.policyRevision, policyHash: binding.policyHash }
  if (small) {
    request.messages[0].content = 'memory experiment small control'
    request.messages[0].contentParts[0].text = request.messages[0].content
  } else {
    const target = grok.LIMITS.maxVisualRequestBodyBytes - 4096
    const room = target - Buffer.byteLength(JSON.stringify(envelope))
    if (room <= 0) throw new Error('Physical structure already exceeds target body size')
    const unit = shape === 'wide-strings' ? 'Ā' : 'x'
    const count = Math.floor(room / (2 * Buffer.byteLength(unit)))
    const text = unit.repeat(count)
    request.messages[0].content = text; request.messages[0].contentParts[0].text = text
  }
  const serialized = Buffer.from(JSON.stringify(envelope))
  const parsed = grok.parseGrokCompletionRequest(request)
  if (!parsed.ok) throw new Error(`Physical synthetic ${shape} fixture is invalid: ${parsed.code}: ${parsed.message}`)
  const scan = grok.scanJsonStructure(serialized, grok.BODY_STRUCTURE_LIMITS)
  if (!Number.isSafeInteger(scan.containers) || !Number.isSafeInteger(scan.elements)) throw new Error('Physical scanner observations missing')
  if (grok.measureNonImageAuthorizeBytes(envelope) > grok.LIMITS.maxRequestBodyBytes) throw new Error('Physical fixture exceeds actual authorize non-image budget')
  const counts = structureOf(request)
  if (!small && (serialized.length < grok.LIMITS.maxVisualRequestBodyBytes - 8192 || serialized.length > grok.LIMITS.maxVisualRequestBodyBytes)) throw new Error('Physical visual fixture is underfilled or oversized')
  if (shape === 'worst-structure' && !small && (counts.containers !== grok.LIMITS.maxRequestContainers || counts.members !== grok.LIMITS.maxRequestMembers || counts.elements !== grok.LIMITS.maxRequestElements)) throw new Error('Worst structure fixture misses an enforced maximum')
  return { bytes: serialized, request, envelope, metadata: { shape: small ? 'small-control' : shape, bytes: serialized.length,
    sha256: sha256(serialized), requestHash: grok.hashGrokCompletionRequest(request), nonImageAuthorizeBytes: grok.measureNonImageAuthorizeBytes(envelope),
    decodedImageBytes: small ? 0 : grok.GROK_VISUAL_LIMITS.maxTotalImageBytes, imageSha256: small ? [] : [sha256(Buffer.from(physicalPng(), 'base64'))], structure: counts } }
}
export function buildRejectedFixture(accepted, kind) {
  const copy = structuredClone(accepted.envelope)
  if (kind === 'codex-cap') {
    copy.request.provider = 'codex-subscription'; copy.request.schemaVersion = 'codex-completion-request.v2'
    const parsed = codex.parseCodexCompletionRequest(copy.request)
    if (parsed.ok || parsed.code !== 'limit') throw new Error('Lower provider cap fixture does not actually exceed Codex bounds')
  } else if (kind === 'elements') {
    const request = copy.request
    request.messages[0].content = ''; request.messages[0].contentParts[0].text = ''
    request.tools = [{ name: 'memory_fixture_rejection', description: 'Synthetic structure refusal control', parameters: { type: 'array', default: Array(grok.BODY_STRUCTURE_LIMITS.maxElements + 1).fill(0) } }]
  } else throw new Error('Unknown physical rejection shape')
  const bytes = Buffer.from(JSON.stringify(copy))
  return { bytes, envelope: copy, metadata: { shape: `rejected-${kind}`, bytes: bytes.length, sha256: sha256(bytes), expectedStatus: 413, expectedError: 'payload_too_large' } }
}
export function buildGfsFixture({ name, sequence }) {
  if (!/^[A-Za-z0-9.-]{1,200}$/.test(name) || !Number.isSafeInteger(sequence) || sequence < 0 || sequence > 255) throw new Error('Invalid GFS fixture binding')
  const content = Buffer.alloc(16 * MIB, sequence)
  const bytes = Buffer.from(JSON.stringify({ name, kind: 'file', contentBase64: content.toString('base64') }))
  if (bytes.length >= 24 * MIB) throw new Error('GFS fixture exceeds the actual GFSC parser cap')
  return { bytes, metadata: { name, decodedBytes: content.length, serializedBytes: bytes.length, sha256: sha256(content), serializedSha256: sha256(bytes), route: '/api/v1/gfs/proxy/v1/resources/{parentRid}/children' } }
}
