const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const waitFor = async (read, description) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${description}`)
}
app.whenReady().then(async () => {
  let window
  try {
    assert.ok(process.env.PR1085_IMAGE_URL, 'missing renderer URL')
    window = new BrowserWindow({ show: true, width: 600, height: 400 })
    const results = []
    for (const kind of ['valid', 'invalid']) {
      await window.loadURL(`${process.env.PR1085_IMAGE_URL}?kind=${kind}`)
      const result = await waitFor(
        () =>
          window.webContents.executeJavaScript(
            'window.__imageProbe?.done ? window.__imageProbe : null'
          ),
        `${kind} decode`
      )
      results.push(result)
    }
    process.stdout.write(`${JSON.stringify({ probe: 'native-image-readiness', results })}\n`)
    assert.equal(results[0].decoded, true, 'valid PNG must actually decode')
    assert.equal(results[1].failed, true, 'invalid PNG must actually fail decoding')
    assert.equal(results[0].writesBeforeDecode, 0, 'valid image cannot copy before decode')
    assert.equal(results[0].writes, 1, 'valid image copies once after decode')
    assert.equal(results[1].writes, 0, 'invalid image cannot copy')
    app.exit(0)
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`)
    if (window && !window.isDestroyed()) window.destroy()
    app.exit(1)
  }
})
