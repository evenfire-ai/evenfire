import electron from 'electron'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
if (typeof electron === 'string') {
  const childEnvironment = { ...process.env }
  delete childEnvironment.ELECTRON_RUN_AS_NODE
  const result = spawnSync(electron, [scriptPath], {
    env: childEnvironment,
    stdio: 'inherit',
  })
  process.exit(result.status ?? 1)
}

const scriptDirectory = path.dirname(scriptPath)
const projectDirectory = path.resolve(scriptDirectory, '..')
const assetsDirectory = path.join(projectDirectory, 'assets')
const iconComposerDirectory = path.join(assetsDirectory, 'adaptive-icon.icon')
const iconComposerAssetsDirectory = path.join(iconComposerDirectory, 'Assets')
const iconSize = 1024
const { app, BrowserWindow, nativeImage } = electron

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

async function renderSvg(svgPath) {
  const svg = await fs.readFile(svgPath, 'utf8')
  const window = new BrowserWindow({
    width: iconSize,
    height: iconSize,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      backgroundThrottling: false,
      offscreen: true,
    },
  })

  try {
    await window.loadURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    const capture = await window.webContents.capturePage({
      x: 0,
      y: 0,
      width: iconSize,
      height: iconSize,
    })
    return capture.resize({ width: iconSize, height: iconSize, quality: 'best' })
  } finally {
    window.destroy()
  }
}

function buildIco(images) {
  const headerSize = 6
  const entrySize = 16
  const entriesSize = images.length * entrySize
  const header = Buffer.alloc(headerSize + entriesSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  let imageOffset = header.length
  for (const [index, image] of images.entries()) {
    const entryOffset = headerSize + index * entrySize
    header.writeUInt8(image.size === 256 ? 0 : image.size, entryOffset)
    header.writeUInt8(image.size === 256 ? 0 : image.size, entryOffset + 1)
    header.writeUInt8(0, entryOffset + 2)
    header.writeUInt8(0, entryOffset + 3)
    header.writeUInt16LE(1, entryOffset + 4)
    header.writeUInt16LE(32, entryOffset + 6)
    header.writeUInt32LE(image.png.length, entryOffset + 8)
    header.writeUInt32LE(imageOffset, entryOffset + 12)
    imageOffset += image.png.length
  }

  return Buffer.concat([header, ...images.map(image => image.png)])
}

async function writeThemeVariant(theme) {
  const image = await renderSvg(path.join(assetsDirectory, `icon-${theme}.svg`))
  const png = image.toPNG({ scaleFactor: 1 })
  await fs.writeFile(path.join(assetsDirectory, `icon-${theme}.png`), png)
}

async function writeWindowsFallbackIcon() {
  const source = nativeImage.createFromPath(path.join(assetsDirectory, 'icon.png'))
  if (source.isEmpty()) {
    throw new Error('Unable to load assets/icon.png for the Windows fallback icon.')
  }

  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images = sizes.map(size => ({
    size,
    png: source.resize({ width: size, height: size, quality: 'best' }).toPNG(),
  }))
  await fs.writeFile(path.join(assetsDirectory, 'icon.ico'), buildIco(images))
}

async function main() {
  await app.whenReady()
  await fs.mkdir(iconComposerAssetsDirectory, { recursive: true })
  await fs.copyFile(
    path.join(assetsDirectory, 'icon.png'),
    path.join(iconComposerAssetsDirectory, 'icon.png')
  )
  await writeThemeVariant('light')
  await writeThemeVariant('dark')
  await writeWindowsFallbackIcon()
}

main()
  .then(() => app.exit(0))
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    app.exit(1)
  })
