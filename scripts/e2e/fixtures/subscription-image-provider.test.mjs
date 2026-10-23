import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { createSubscriptionImageVendor, SUBSCRIPTION_VENDOR_URLS } from './subscription-image-provider.mjs'
import { tileChallengeImage } from './subscription-image-challenge.cjs'

const bindings = [
  { provider: 'grok-subscription', modelId: 'unit-grok-image', unsupportedModelId: 'unit-grok-text' },
  { provider: 'codex-subscription', modelId: 'unit-codex-image', unsupportedModelId: 'unit-codex-text' },
]

function request(images, receipt = randomUUID(), model = bindings[0].modelId, journey = '') {
  const prompt = [
    ...(journey ? [journey] : []),
    'Read each image in order.',
    `Receipt: ${receipt}`,
  ].join('\n')
  return { method: 'POST', body: JSON.stringify({ model, input: [{ role: 'user', content: [
    { type: 'input_text', text: prompt },
    ...images.map(image => ({ type: 'input_image', image_url: `data:image/${image.format};base64,${image.bytes.toString('base64')}`, detail: 'high' })),
  ] }] }) }
}

const image = format => ({ ...tileChallengeImage(format, { requirePixels: true }), format })
const digest = value => createHash('sha256').update(value).digest('hex')
const vendor = () => createSubscriptionImageVendor({ runId: 'subscription-image-123456abcdef', bindings })
const responseCode = async response => {
  if (response.status !== 200) return (await response.json()).error.code
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  return events.find(event => event.type === 'response.output_text.delta')?.delta
}
const functionCalls = async response => {
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  const added = events.filter(event => event.type === 'response.output_item.added')
  return added.map(event => {
    const callId = event.item.call_id
    const delta = events.find(item => item.type === 'response.function_call_arguments.delta' && item.item_id === event.item.id)
    const done = events.find(item => item.type === 'response.function_call_arguments.done' && item.item_id === event.item.id)
    return { type: event.item.type, callId, name: event.item.name, arguments: JSON.parse(done.arguments), delta, done }
  })
}

function screenshotPrompt(path, region, receipt = randomUUID()) {
  return [
    'Journey: tool-screenshot',
    `Screen fixture: ${path}`,
    `Screenshot region: ${JSON.stringify(region)}`,
    'First use shell_exec to check that the prepared screen file exists with exactly this command:',
    `test -r ${path}`,
    'Wait for my visible approval. Then use desktop_screenshot once for that region of the actual desktop.',
    'Read the 64-bit hexadecimal challenge from its pixels. Reply with that code only.',
    `Receipt: ${receipt}`,
  ].join('\n')
}

function userMessage(text, images = []) {
  return { role: 'user', content: [
    { type: 'input_text', text },
    ...images.map(item => ({ type: 'input_image', image_url: `data:image/${item.format};base64,${item.bytes.toString('base64')}` })),
  ] }
}

function callItem(callId, name, args) {
  return { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) }
}

function outputItem(callId, output) {
  return { type: 'function_call_output', call_id: callId, output }
}

function screenshotRequests(fixture, imageBytes) {
  const prompt = screenshotPrompt(fixture.path, fixture.region)
  const user = userMessage(prompt)
  const shellCall = callItem('call-shell', 'shell_exec', { command: `test -r ${fixture.path}` })
  const frameCall = callItem('call-frame', 'desktop_screenshot', { region: fixture.region })
  return {
    prompt,
    prepare: { method: 'POST', body: JSON.stringify({ model: bindings[0].modelId, input: [user] }) },
    capture: { method: 'POST', body: JSON.stringify({ model: bindings[0].modelId, input: [
      user, shellCall, outputItem('call-shell', '(no output)'), frameCall,
    ] }) },
    pixels: { method: 'POST', body: JSON.stringify({ model: bindings[0].modelId, input: [
      user,
      shellCall,
      outputItem('call-shell', '(no output)'),
      frameCall,
      outputItem('call-frame', JSON.stringify({ attachmentId: 'att-capture', delivery: 'image_input' })),
      userMessage('These images are output of the tools above.', imageBytes ? [{ format: 'png', bytes: imageBytes }] : []),
    ] }) },
    shellCall,
    frameCall,
  }
}

function referenceLine(file) {
  return [
    'referenced_file: id="' + file.referenceId + '"',
    'name="' + file.name + '"',
    'source=gfs',
    'drive="' + file.drive + '"',
    'resourceId="' + file.resourceId + '"',
    'version=' + file.version,
    'class=image',
    'bytes=' + file.byteLength,
    'availability=available',
  ].join(' ')
}

function gfsFixture() {
  return [
    { referenceId: `gfs:qa-drive:${'a'.repeat(32)}@v3`, drive: 'qa-drive', resourceId: 'a'.repeat(32), version: 3, name: 'first.png', byteLength: 512 },
    { referenceId: `gfs:qa-drive:${'b'.repeat(32)}@v1`, drive: 'qa-drive', resourceId: 'b'.repeat(32), version: 1, name: 'second.png', byteLength: 512 },
  ]
}

function gfsRequests(files, imageBytes = []) {
  const lines = files.map(referenceLine).join('\n')
  const instructions = 'Use the references below.\n' + lines
  const prompt = [
    'Journey: gfs-image',
    'GFS targets: ' + JSON.stringify(files.map(file => ({
      drive: file.drive,
      resourceId: file.resourceId,
      version: file.version,
    }))),
    lines,
    'Use clerum__gfs_read for each attached image in this order.',
    `Receipt: ${randomUUID()}`,
  ].join('\n')
  const user = userMessage(prompt)
  const calls = files.map((file, index) => callItem(`call-read-${index}`, 'clerum__gfs_read', {
    drive: file.drive,
    resourceId: file.resourceId,
    expectedVersion: file.version,
  }))
  const outputs = files.map((file, index) => outputItem(`call-read-${index}`, JSON.stringify({
    resource: {
      kind: 'gfs',
      drive: file.drive,
      resourceId: file.resourceId,
      version: file.version,
      gfsUri: `gfs://${file.drive}/${file.resourceId}`,
    },
    delivery: 'image_input',
  })))
  return {
    prepare: { method: 'POST', body: JSON.stringify({
      model: bindings[0].modelId,
      instructions,
      input: [user],
    }) },
    pixels: { method: 'POST', body: JSON.stringify({
      model: bindings[0].modelId,
      instructions,
      input: [user, ...calls, ...outputs, userMessage('These images were read by the tools above.', imageBytes)],
    }) },
  }
}

test('screenshot state machine calls the real shell, then screenshot, and answers only decoded wire pixels', async () => {
  const subject = vendor()
  const frame = image('png')
  const requests = screenshotRequests({ path: '/tmp/evenfire-qa-screen-0189f3ab-28c1-4f61-9245-58ba7d02e4a2.png', region: { x: 8, y: 16, w: 512, h: 512 } }, frame.bytes)
  const prepare = await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, requests.prepare)
  const shellCalls = await functionCalls(prepare)
  assert.deepEqual(shellCalls, [{ type: 'function_call', callId: shellCalls[0].callId, name: 'shell_exec', arguments: { command: `test -r ${requests.prompt.match(/Screen fixture: (\S+)/)[1]}` }, delta: shellCalls[0].delta, done: shellCalls[0].done }])
  assert.equal(shellCalls[0].delta.delta, shellCalls[0].done.arguments)

  const capture = await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, requests.capture)
  const frameCalls = await functionCalls(capture)
  assert.deepEqual(frameCalls.map(call => [call.name, call.arguments]), [['desktop_screenshot', { region: { x: 8, y: 16, w: 512, h: 512 } }]])

  assert.equal(await responseCode(await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, requests.pixels)), frame.code)
  const rows = subject.snapshot().attempts
  assert.deepEqual(rows.map(row => [row.journey, row.stage, row.responseKind]), [
    ['tool-screenshot', 'prepare', 'tool_calls'],
    ['tool-screenshot', 'capture', 'tool_calls'],
    ['tool-screenshot', 'pixels', 'pixels'],
  ])
  assert.deepEqual(rows[0].toolCalls, [{ id: shellCalls[0].callId, name: 'shell_exec', argumentsSha256: digest(requests.shellCall.arguments) }])
  assert.equal(rows[1].toolOutputs[0].outputSha256, digest('(no output)'))
  assert.deepEqual(rows[2].decodedPixels, [{ width: 512, height: 512 }])
  assert.equal(rows[2].outputSha256, digest(frame.code))
})

test('same vendor handles three repeated 20-image requests in one PID without answer leakage', { timeout: 120_000 }, async () => {
  const subject = vendor()
  const cycles = Array.from({ length: 3 }, () => Array.from({ length: 20 }, (_, index) => image(index % 2 ? 'jpeg' : 'png')))
  const allImages = cycles.flat()
  for (const [index, images] of cycles.entries()) {
    const receipt = randomUUID()
    const response = await subject.respond(
      SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses,
      request(images, receipt, bindings[0].modelId),
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    const expected = images.map(item => item.code).join('\n')
    for (const [name, value] of response.headers.entries()) {
      assert(!value.includes(expected), `${name} leaked the ordered answer`)
      for (const item of images) {
        assert(!value.includes(item.code), `${name} leaked a pixel answer`)
        assert(!value.includes(item.bytes.toString('base64')), `${name} leaked image bytes`)
      }
    }
    assert.equal(await responseCode(response), expected)
  }
  const rows = subject.snapshot().attempts
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(row => row.sequence), [1, 2, 3])
  assert.deepEqual(rows.map(row => row.imageSha256.length), [20, 20, 20])
  assert.deepEqual(rows.map(row => row.decodedPixels.length), [20, 20, 20])
  for (const row of rows) {
    assert.equal(row.responseKind, 'pixels')
    assert.deepEqual(row.receivedImageOrder, row.imageSha256)
    assert(row.decodedPixels.every(pixel => pixel.width === 512 && pixel.height === 512))
  }
  const serialized = JSON.stringify(subject.snapshot())
  for (const item of allImages) {
    assert(!serialized.includes(item.code))
    assert(!serialized.includes(item.bytes.toString('base64')))
  }
})

test('both subscription external peers answer from ordered received pixels and publish only bounded evidence', async () => {
  const subject = vendor()
  const images = [image('png'), image('jpeg')]
  for (const binding of bindings) {
    const response = await subject.respond(SUBSCRIPTION_VENDOR_URLS[binding.provider].responses, request(images, randomUUID(), binding.modelId))
    assert.equal(await responseCode(response), images.map(item => item.code).join('\n'))
  }
  const evidence = subject.snapshot()
  assert.equal(evidence.attempts.length, 2)
  assert.equal(evidence.attempts[0].imageSha256.length, 2)
  assert.deepEqual(evidence.attempts[0].receivedImageOrder, evidence.attempts[0].imageSha256)
  assert.deepEqual(evidence.attempts[0].decodedPixels, [{ width: 512, height: 512 }, { width: 512, height: 512 }])
  assert.equal(evidence.attempts[0].responseKind, 'pixels')
  const serialized = JSON.stringify(evidence)
  for (const item of images) {
    assert(!serialized.includes(item.code))
    assert(!serialized.includes(item.bytes.toString('base64')))
  }
})

test('removing, replacing or reordering wire bytes cannot satisfy the original ordered oracle', async () => {
  const subject = vendor()
  const images = [image('png'), image('jpeg')]
  const expected = images.map(item => item.code).join('\n')
  const output = async input => responseCode(await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, request(input)))
  assert.equal(await output(images), expected)
  assert.notEqual(await output([...images].reverse()), expected)
  assert.notEqual(await output(images.slice(0, 1)), expected)
  assert.notEqual(await output([]), expected)
  assert.notEqual(await output([image('png'), images[1]]), expected)
})

test('rejects no-code images, unsupported models and every non-vendor boundary', async () => {
  const subject = vendor()
  assert.equal(await responseCode(await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, request([{ format: 'png', bytes: Buffer.from([1, 2, 3]) }]))), 'image_challenge_unreadable')
  const malformedCompletePng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4),
    Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ])
  assert.equal(await responseCode(await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, request([{ format: 'png', bytes: malformedCompletePng }]))), 'image_challenge_unreadable')
  const unsupported = await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, request([image('png')], randomUUID(), bindings[0].unsupportedModelId))
  assert.equal(await responseCode(unsupported), 'image_model_unsupported')
  for (const url of ['https://example.invalid/api/v1/mcp-host/llm-provider-attempts/authorize', 'https://fixture.invalid/responses', SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses + '?escape=1']) {
    await assert.rejects(() => subject.respond(url, request([image('png')])), /external vendor boundary/)
  }
  const survivor = image('png')
  assert.equal(await responseCode(await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, request([survivor]))), survivor.code)
})

test('bounds retained attempts and request bodies rather than hiding missing evidence', async () => {
  const subject = createSubscriptionImageVendor({ runId: 'subscription-image-123456abcdef', bindings, maxAttempts: 1 })
  await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, request([]))
  await assert.rejects(() => subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, request([])), /evidence bound/)
})

test('screenshot rejects wrong commands, wrong shell output, and header-only capture pixels', async () => {
  const fixture = { path: '/tmp/evenfire-qa-screen-0189f3ab-28c1-4f61-9245-58ba7d02e4a2.png', region: { x: 0, y: 0, w: 512, h: 512 } }
  const subject = vendor()
  const wrongCommand = { method: 'POST', body: JSON.stringify({ model: bindings[0].modelId, input: [
    userMessage(screenshotPrompt(fixture.path, fixture.region)), callItem('call-shell', 'shell_exec', { command: 'test -r /other.png' }),
  ] }) }
  assert.equal(await responseCode(await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, wrongCommand)), 'tool_source_invalid')
  const wrongOutput = { method: 'POST', body: JSON.stringify({ model: bindings[0].modelId, input: [
    userMessage(screenshotPrompt(fixture.path, fixture.region)), callItem('call-shell', 'shell_exec', { command: `test -r ${fixture.path}` }), outputItem('call-shell', 'ok'),
  ] }) }
  assert.equal(await responseCode(await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, wrongOutput)), 'tool_source_invalid')
  const headerOnly = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const complete = screenshotRequests(fixture, headerOnly)
  await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, complete.prepare)
  await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, complete.capture)
  assert.equal(await responseCode(await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, complete.pixels)), 'image_challenge_unreadable')
})

test('GFS emits ordered reads from projected references and answers in received wire order', async () => {
  const subject = vendor()
  const files = gfsFixture()
  const frames = [image('png'), image('jpeg')]
  const requests = gfsRequests(files, frames)
  const read = await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, requests.prepare)
  const calls = await functionCalls(read)
  assert.deepEqual(calls.map(call => [call.type, call.name, call.arguments]), [
    ['function_call', 'clerum__gfs_read', { drive: files[0].drive, resourceId: files[0].resourceId, expectedVersion: files[0].version }],
    ['function_call', 'clerum__gfs_read', { drive: files[1].drive, resourceId: files[1].resourceId, expectedVersion: files[1].version }],
  ])
  assert.equal(await responseCode(await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, requests.pixels)), frames.map(frame => frame.code).join('\n'))
  const parsedPixels = JSON.parse(requests.pixels.body)
  const reversedPixels = { ...parsedPixels, input: [
    ...parsedPixels.input.slice(0, -1),
    userMessage('These images were read by the tools above.', [...frames].reverse()),
  ] }
  assert.equal(await responseCode(await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, {
    method: 'POST',
    body: JSON.stringify(reversedPixels),
  })), [...frames].reverse().map(frame => frame.code).join('\n'))
  const [readRow, pixelRow] = subject.snapshot().attempts
  assert.deepEqual(readRow.stage, 'read')
  assert.deepEqual(readRow.responseKind, 'tool_calls')
  assert.deepEqual(readRow.referencedFiles, files.map(({ referenceId, drive, resourceId, version, byteLength }) => ({
    referenceId, drive, resourceId, version, availability: 'available', byteLength,
  })))
  assert.deepEqual(pixelRow.toolOutputs.map(output => output.resource), files.map(file => ({
    kind: 'gfs', drive: file.drive, resourceId: file.resourceId, version: file.version, gfsUri: `gfs://${file.drive}/${file.resourceId}`,
  })))
  assert.deepEqual(pixelRow.decodedPixels, [{ width: 512, height: 512 }, { width: 512, height: 512 }])
})

test('GFS missing, mismatched, or undecodable source delivery fails causally', async () => {
  const files = gfsFixture()
  const frames = [image('png'), image('jpeg')]
  const subject = vendor()
  const requests = gfsRequests(files, frames)
  const missingInstructions = { method: 'POST', body: JSON.stringify({ model: bindings[0].modelId, input: JSON.parse(requests.prepare.body).input }) }
  assert.equal(await responseCode(await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, missingInstructions)), 'referenced_files_invalid')
  const pixelInput = JSON.parse(requests.pixels.body).input
  const mismatched = { method: 'POST', body: JSON.stringify({ model: bindings[0].modelId, instructions: JSON.parse(requests.prepare.body).instructions, input: [
    pixelInput[0],
    callItem('call-read-0', 'clerum__gfs_read', { drive: files[0].drive, resourceId: files[0].resourceId, expectedVersion: files[0].version }),
    outputItem('call-read-0', JSON.stringify({ resource: { kind: 'gfs', drive: files[0].drive, resourceId: files[1].resourceId, version: files[0].version, gfsUri: `gfs://${files[0].drive}/${files[0].resourceId}` }, delivery: 'image_input' })),
    callItem('call-read-1', 'clerum__gfs_read', { drive: files[1].drive, resourceId: files[1].resourceId, expectedVersion: files[1].version }),
    outputItem('call-read-1', pixelInput[3].output),
  ] }) }
  assert.equal(await responseCode(await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, mismatched)), 'tool_state_invalid')
  const headerOnly = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const unreadable = gfsRequests(files, [{ format: 'png', bytes: headerOnly }, frames[1]])
  await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, unreadable.prepare)
  assert.equal(await responseCode(await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, unreadable.pixels)), 'image_challenge_unreadable')
  const missingPixels = gfsRequests(files, [frames[0]])
  await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, missingPixels.prepare)
  assert.equal(await responseCode(await subject.respond(SUBSCRIPTION_VENDOR_URLS['grok-subscription'].responses, missingPixels.pixels)), 'tool_state_invalid')
})
