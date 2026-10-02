import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createSubscriptionImageVendor, SUBSCRIPTION_VENDOR_URLS } from './subscription-image-provider.mjs'
import { tileChallengeImage } from './subscription-image-challenge.cjs'

const bindings = [
  { provider: 'grok-subscription', modelId: 'unit-grok-image', unsupportedModelId: 'unit-grok-text' },
  { provider: 'codex-subscription', modelId: 'unit-codex-image', unsupportedModelId: 'unit-codex-text' },
]
function request(images, receipt = randomUUID(), model = bindings[0].modelId) {
  return { method: 'POST', body: JSON.stringify({ model, input: [{ role: 'user', content: [
    { type: 'input_text', text: `Read each image in order. Receipt: ${receipt}` },
    ...images.map(image => ({ type: 'input_image', image_url: `data:image/${image.format};base64,${image.bytes.toString('base64')}`, detail: 'high' })),
  ] }] }) }
}
const image = format => ({ ...tileChallengeImage(format, { requirePixels: true }), format })

test('both subscription external peers answer from ordered received pixels and publish only bounded evidence', async () => {
  const vendor = createSubscriptionImageVendor({ runId: 'subscription-image-123456abcdef', bindings })
  const images = [image('png'), image('jpeg')]
  for (const binding of bindings) {
    const response = await vendor.respond(SUBSCRIPTION_VENDOR_URLS[binding.provider].responses, request(images, randomUUID(), binding.modelId))
    assert.equal(response.status, 200)
    const delta = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(event => event.type === 'response.output_text.delta')
    assert.equal(delta.delta, images.map(item => item.code).join('\n'))
  }
  const evidence = vendor.snapshot()
  assert.equal(evidence.attempts.length, 2)
  assert.equal(evidence.attempts[0].imageSha256.length, 2)
  assert.equal(evidence.attempts[0].responseKind, 'pixels')
  const serialized = JSON.stringify(evidence)
  for (const item of images) {
    assert(!serialized.includes(item.code))
    assert(!serialized.includes(item.bytes.toString('base64')))
  }
})

test('removing, replacing or reordering wire bytes cannot satisfy the original ordered oracle', async () => {
  const vendor = createSubscriptionImageVendor({ runId: 'subscription-image-123456abcdef', bindings })
  const images = [image('png'), image('jpeg')]
  const expected = images.map(item => item.code).join('\n')
  const output = async input => {
    const response = await vendor.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, request(input))
    const stream = await response.text()
    const events = stream.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    return events.find(event => event.type === 'response.output_text.delta')?.delta
  }
  assert.equal(await output(images), expected)
  assert.notEqual(await output([...images].reverse()), expected)
  assert.notEqual(await output(images.slice(0, 1)), expected)
  assert.notEqual(await output([]), expected)
  assert.notEqual(await output([image('png'), images[1]]), expected)
})

test('rejects no-code images, unsupported models and every non-vendor boundary', async () => {
  const vendor = createSubscriptionImageVendor({ runId: 'subscription-image-123456abcdef', bindings })
  const response = await vendor.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, request([{ format: 'png', bytes: Buffer.from([1, 2, 3]) }]))
  assert.equal(response.status, 422)
  const unsupported = await vendor.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, request([image('png')], randomUUID(), bindings[0].unsupportedModelId))
  assert.equal(unsupported.status, 422)
  for (const url of ['https://example.invalid/api/v1/mcp-host/llm-provider-attempts/authorize', 'https://fixture.invalid/responses', SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses + '?escape=1']) {
    await assert.rejects(() => vendor.respond(url, request([image('png')])), /external vendor boundary/)
  }
})

test('bounds retained attempts and request bodies rather than hiding missing evidence', async () => {
  const vendor = createSubscriptionImageVendor({ runId: 'subscription-image-123456abcdef', bindings, maxAttempts: 1 })
  await vendor.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, request([]))
  await assert.rejects(() => vendor.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, request([])), /evidence bound/)
})
