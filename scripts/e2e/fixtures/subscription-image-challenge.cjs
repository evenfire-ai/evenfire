// E2E_GUARDIAN_IPC_FLOW: test-only generation/collection for Electron IPC journeys; no renderer HTTP transition.
/** Test-only codec. Answers come from received RGBA cells, never names, metadata or a digest registry. */
const { randomBytes } = require('node:crypto')
const { createRequire } = require('node:module')
const path = require('node:path')

const hostRequire = createRequire(path.resolve(__dirname, '../../../mcp-host/package.json'))
const levels = [32, 96, 160, 224]
const palette = levels.flatMap(red => levels.map(green => [red, green, 80]))
const markers = [[240, 24, 240], [24, 240, 240], [240, 240, 24], [24, 24, 240]]

function requirePixelRenderer() {
  let native
  try { native = hostRequire('@napi-rs/canvas') } catch {
    throw new Error('Subscription image fixture requires native canvas pixels')
  }
  // Resolve and exercise the addon before any launch, including its image encoder.
  const canvas = native.createCanvas(2, 2)
  canvas.getContext('2d').fillRect(0, 0, 2, 2)
  if (!canvas.toBuffer('image/png').length || typeof native.loadImage !== 'function') {
    throw new Error('Subscription image fixture requires native pixel rendering and decoding')
  }
  return native
}

function tileChallengeImage(format, options) {
  if (options?.requirePixels !== true) throw new Error('Tile challenges require explicit native pixels')
  if (!['png', 'jpeg'].includes(format)) throw new Error('Unsupported challenge format')
  const { createCanvas } = requirePixelRenderer()
  const width = 512, height = 512
  const code = randomBytes(8).toString('hex').toUpperCase()
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = 'white'
  context.fillRect(0, 0, width, height)
  for (let index = 0; index < 16; index++) {
    context.fillStyle = `rgb(${palette[parseInt(code[index], 16)].join(',')})`
    context.fillRect(64 + (index % 4) * 96, 64 + Math.floor(index / 4) * 96, 96, 96)
  }
  for (let index = 0; index < 4; index++) {
    context.fillStyle = `rgb(${markers[index].join(',')})`
    const x = index % 2 ? 464 : 16
    const y = index >= 2 ? 464 : 16
    context.fillRect(x, y, 32, 32)
  }
  return { code, bytes: canvas.toBuffer(`image/${format}`), width, height }
}

function sample(context, x, y) {
  const data = context.getImageData(Math.floor(x) - 2, Math.floor(y) - 2, 5, 5).data
  const sums = [0, 0, 0]
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] < 250) throw new Error('Image challenge has transparent pixels')
    for (let component = 0; component < 3; component++) sums[component] += data[offset + component]
  }
  return sums.map(value => value / 25)
}
const distance = (left, right) => Math.max(...left.map((value, index) => Math.abs(value - right[index])))

async function decodeTileChallenge(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 20 * 1024 * 1024) {
    throw new Error('Image challenge decode byte bound exceeded')
  }
  const { createCanvas, loadImage } = requirePixelRenderer()
  let image
  try { image = await loadImage(bytes) } catch { throw new Error('Image challenge cannot decode received bytes') }
  if (image.width !== 512 || image.height !== 512) throw new Error('Image challenge geometry is unsupported')
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  for (let index = 0; index < 4; index++) {
    const actual = sample(context, index % 2 ? 480 : 32, index >= 2 ? 480 : 32)
    if (distance(actual, markers[index]) > 24) throw new Error('Image challenge marker is missing')
  }
  let code = ''
  for (let index = 0; index < 16; index++) {
    const actual = sample(context, 112 + (index % 4) * 96, 112 + Math.floor(index / 4) * 96)
    const candidates = palette.map((color, digit) => ({ digit, distance: distance(actual, color) }))
      .filter(candidate => candidate.distance <= 24)
    if (candidates.length !== 1) throw new Error('Image challenge tile is undecodable')
    code += candidates[0].digit.toString(16).toUpperCase()
  }
  return code
}

// CommonJS is shared by Playwright's CommonJS transform and the ESM external peer.
module.exports = { requirePixelRenderer, tileChallengeImage, decodeTileChallenge }
