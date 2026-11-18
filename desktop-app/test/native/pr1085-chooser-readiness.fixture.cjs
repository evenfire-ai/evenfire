const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, WebContentsView } = require('electron')

async function waitFor(read, label) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

app.whenReady().then(async () => {
  let window
  let resultCode = 0
  try {
    if (process.env.PR1085_CHECK_FAILURE_STATUS === '1')
      throw new Error('intentional fixture failure')
    window = new BrowserWindow({ show: true, width: 900, height: 600 })
    const view = new WebContentsView({ webPreferences: { sandbox: true } })
    window.contentView.addChildView(view)
    view.setBounds({ x: 280, y: 0, width: 620, height: 600 })
    await view.webContents.loadURL('data:text/html,<title>Native application</title>')
    await window.loadURL(process.env.PR1085_CHOOSER_URL)
    const wc = window.webContents
    await waitFor(() => wc.executeJavaScript('window.__nativeSidebarReady === true'), 'Sidebar')
    wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Page.enable')
    await wc.debugger.sendCommand('DOM.enable')
    await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
    const chooserEvents = []
    wc.debugger.on('message', (_event, method, params) => {
      if (method === 'Page.fileChooserOpened') chooserEvents.push(params)
    })
    await wc.executeJavaScript(`(() => {
      document.addEventListener('click', e => {
        if (e.target.closest('[data-gfs-action="replace"]')) {
          window.__replaceGesture = { trusted: e.isTrusted, active: navigator.userActivation.isActive }
        }
      }, true)
      const row = [...document.querySelectorAll('.da-file-explorer__row')].find(el => el.textContent.includes('native-menu-file.md'))
      row.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 140 })
      )
    })()`)
    const point = await waitFor(
      () =>
        wc.executeJavaScript(`(() => {
      const el = document.querySelector('[data-gfs-action="replace"]')
      if (!el || el.disabled) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`),
      'enabled Replace action'
    )
    wc.sendInputEvent({ type: 'mouseMove', ...point })
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await waitFor(() => chooserEvents.length, 'native file chooser')
    const gesture = await wc.executeJavaScript('window.__replaceGesture')
    assert.deepEqual(
      gesture,
      { trusted: true, active: true },
      'Replace click has trusted activation'
    )
    assert.equal(chooserEvents.length, 1, 'one native chooser opened')
    const selected = path.resolve('ui/native-tests/pr1085-chooser-readiness.html')
    await wc.debugger.sendCommand('DOM.setFileInputFiles', {
      files: [selected],
      backendNodeId: chooserEvents[0].backendNodeId,
    })
    const result = await waitFor(
      () => wc.executeJavaScript('window.__chooserResult'),
      'selected File dispatch'
    )
    assert.deepEqual(result, {
      action: 'replace',
      resourceId: 'native-sidebar-file',
      gfsUri: 'gfs://main/native-sidebar-file',
      version: 1,
      fileName: path.basename(selected),
      text: fs.readFileSync(selected, 'utf8'),
    })
    assert.equal(chooserEvents.length, 1, 'selection did not open a second chooser')
    console.log(
      'PASS: trusted Replace opened one chooser and dispatched exact target, version and selected file'
    )

    await wc.executeJavaScript(`(() => {
      window.__chooserResult = null
      const row = [...document.querySelectorAll('.da-file-explorer__row')].find(el => el.textContent.includes('native-menu-file.md'))
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 140 }))
    })()`)
    const firstPoint = await waitFor(
      () =>
        wc.executeJavaScript(`(() => {
      const el = document.querySelector('[data-gfs-action="replace"]')
      if (!el || el.disabled) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`),
      'first Replace action'
    )
    wc.sendInputEvent({ type: 'mouseMove', ...firstPoint })
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...firstPoint })
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...firstPoint })
    await waitFor(() => chooserEvents.length === 2, 'held first-row chooser')
    await wc.executeJavaScript(`(() => {
      const input = document.querySelector('[aria-label="Replace native-menu-file.md"]')
      window.__staleInputChange = 0
      input.addEventListener('change', () => window.__staleInputChange++)
      const row = [...document.querySelectorAll('.da-file-explorer__row')].find(el => el.textContent.includes('zz-second.md'))
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 180 }))
    })()`)
    await waitFor(
      () =>
        wc.executeJavaScript(
          'Boolean(document.querySelector(\'[aria-label="Actions for zz-second.md"]\'))'
        ),
      'new second-row owner'
    )
    await wc.debugger.sendCommand('DOM.setFileInputFiles', {
      files: [selected],
      backendNodeId: chooserEvents[1].backendNodeId,
    })
    await waitFor(
      () => wc.executeJavaScript('window.__staleInputChange === 1'),
      'old input selection delivery'
    )
    assert.equal(
      await wc.executeJavaScript('window.__chooserResult'),
      null,
      'old selection did not dispatch to either row'
    )
    assert.deepEqual(await wc.executeJavaScript('window.__chooserCalls'), [
      'replace:native-sidebar-file',
    ])
    assert.equal(chooserEvents.length, 2, 'changing row did not open a picker')
    console.log('PASS: delivered old selection cannot dispatch after a new row takes ownership')
    const secondPoint = await waitFor(
      () =>
        wc.executeJavaScript(`(() => {
      const menu = document.querySelector('[aria-label="Actions for zz-second.md"]')
      const el = menu?.querySelector('[data-gfs-action="replace"]')
      if (!el || el.disabled) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`),
      'second Replace action'
    )
    wc.sendInputEvent({ type: 'mouseMove', ...secondPoint })
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...secondPoint })
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...secondPoint })
    await waitFor(() => chooserEvents.length === 3, 'second-row chooser')
    assert.deepEqual(await wc.executeJavaScript('window.__replaceGesture'), {
      trusted: true,
      active: true,
    })
    await wc.debugger.sendCommand('DOM.setFileInputFiles', {
      files: [selected],
      backendNodeId: chooserEvents[2].backendNodeId,
    })
    const secondResult = await waitFor(
      () => wc.executeJavaScript('window.__chooserResult'),
      'second-row selected file'
    )
    assert.deepEqual(secondResult, {
      action: 'replace',
      resourceId: 'native-sidebar-second',
      gfsUri: 'gfs://main/native-sidebar-second',
      version: 2,
      fileName: path.basename(selected),
      text: fs.readFileSync(selected, 'utf8'),
    })
    assert.equal(chooserEvents.length, 3, 'one chooser per trusted Replace gesture')
    assert.deepEqual(await wc.executeJavaScript('window.__chooserCalls'), [
      'replace:native-sidebar-file',
      'replace:native-sidebar-second',
    ])
    console.log('PASS: new row selects the exact file with its own target and version')
    if (process.env.PR1085_CHECK_UPLOAD_GESTURE === '1') {
      await wc.executeJavaScript(`(() => {
        const row = [...document.querySelectorAll('.da-file-explorer__row')].find(el => el.textContent.includes('upload-folder'))
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 100 }))
        document.addEventListener('click', e => {
          if (e.target.closest('[data-gfs-action="upload-file"]')) {
            window.__uploadGesture = { trusted: e.isTrusted, active: navigator.userActivation.isActive }
          }
        }, true)
      })()`)
      const uploadPoint = await waitFor(
        () =>
          wc.executeJavaScript(`(() => {
        const menu = document.querySelector('[aria-label="Actions for upload-folder"]')
        const el = menu?.querySelector('[data-gfs-action="upload-file"]')
        if (!el || el.disabled) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`),
        'Upload action'
      )
      wc.sendInputEvent({ type: 'mouseMove', ...uploadPoint })
      wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...uploadPoint })
      wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...uploadPoint })
      const upload = await waitFor(
        () => wc.executeJavaScript('window.__uploadDispatch'),
        'Upload dispatch'
      )
      assert.deepEqual(await wc.executeJavaScript('window.__uploadGesture'), {
        trusted: true,
        active: true,
      })
      assert.deepEqual(upload, {
        resourceId: 'native-sidebar-folder',
        active: true,
        hasFile: false,
      })
      await new Promise(resolve => setTimeout(resolve, 500))
      console.log(
        `OBSERVED: Upload reached the observer callback; chooser count ${chooserEvents.length - 3}; full App not mounted`
      )
    }
  } catch (error) {
    console.error(error)
    resultCode = 1
  } finally {
    if (window && !window.isDestroyed()) window.destroy()
    app.exit(resultCode)
  }
})
