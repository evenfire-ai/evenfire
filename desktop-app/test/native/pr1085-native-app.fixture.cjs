const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, WebContentsView } = require('electron')
async function waitFor(read, name) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${name}`)
}
app.whenReady().then(async () => {
  let window
  let status = 0
  try {
    window = new BrowserWindow({
      show: true,
      width: 900,
      height: 600,
      webPreferences: { sandbox: true },
    })
    const view = new WebContentsView({ webPreferences: { sandbox: true } })
    window.contentView.addChildView(view)
    view.setBounds({ x: 328, y: 0, width: 572, height: 600 })
    await view.webContents.loadURL('data:text/html,<title>Native application</title>')
    const wc = window.webContents
    await window.loadURL(process.env.PR1085_APP_URL)
    await waitFor(
      () =>
        wc.executeJavaScript(
          `Boolean(document.querySelector('[aria-label="Expand file explorer"]'))`
        ),
      'App sidebar'
    )
    await wc.executeJavaScript(`(() => {
      const ok = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'OK')
      ok?.click()
      document.querySelector('[aria-label="Expand file explorer"]').click()
    })()`)
    await waitFor(
      () =>
        wc.executeJavaScript(
          `Boolean([...document.querySelectorAll('.da-file-explorer__row')].find(e => e.textContent.includes('Upload folder')))`
        ),
      'Sidebar folder'
    )
    wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Page.enable')
    await wc.debugger.sendCommand('DOM.enable')
    await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', {
      enabled: true,
      ...(process.env.PR1085_CANCEL_CHOOSER === '1' ? { cancel: true } : {}),
    })
    const events = []
    wc.debugger.on('message', (_event, method, params) => {
      if (method === 'Page.fileChooserOpened') events.push(params)
    })
    if (process.env.PR1085_REPLACE_CANCEL === '1') {
      await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', {
        enabled: true,
        cancel: true,
      })
      await wc.executeJavaScript(`(() => {
        window.__replaceCancels = 0; window.__replaceInputClicks = 0; window.__replaceGestures = []
        document.addEventListener('cancel', e => {
          if (e.target instanceof HTMLInputElement && e.target.type === 'file') { window.__replaceCancels++; window.__replaceCancelTrusted = e.isTrusted }
        }, true)
        document.addEventListener('click', e => {
          if (e.target.closest('[data-gfs-action="replace"]')) window.__replaceGestures.push({ trusted: e.isTrusted, active: navigator.userActivation.isActive })
          if (e.target instanceof HTMLInputElement && e.target.type === 'file') window.__replaceInputClicks++
        }, true)
      })()`)
      async function clickReplace() {
        await wc.executeJavaScript(`(() => {
          const row = [...document.querySelectorAll('.da-file-explorer__row')].find(e => e.textContent.includes('Replace target.txt'))
          row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 150 }))
        })()`)
        const point = await waitFor(
          () =>
            wc.executeJavaScript(`(() => {
          const el = document.querySelector('[data-gfs-action="replace"]')
          if (!el || el.disabled) return null
          const r = el.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }
        })()`),
          'Replace action'
        )
        wc.sendInputEvent({ type: 'mouseMove', ...point })
        wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
        wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
      }
      await waitFor(
        () =>
          wc.executeJavaScript(
            `Boolean([...document.querySelectorAll('.da-file-explorer__row')].find(e => e.textContent.includes('Replace target.txt')))`
          ),
        'Sidebar file'
      )
      await clickReplace()
      await waitFor(
        () => wc.executeJavaScript('window.__replaceCancels === 1'),
        'Replace cancel event'
      )
      assert.equal(await wc.executeJavaScript('window.__replaceCancelTrusted'), true)
      assert.equal(await wc.executeJavaScript('window.__replaceInputClicks'), 1)
      await wc.executeJavaScript('new Promise(resolve => setTimeout(resolve, 250))')
      assert.equal(await wc.executeJavaScript('(window.__replaceCalls ?? []).length'), 0)
      await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', {
        enabled: true,
        cancel: false,
      })
      const before = events.length
      await clickReplace()
      await waitFor(() => events.length > before, 'fresh Replace chooser')
      assert.equal(events.length, before + 1)
      const selected = path.resolve('ui/native-tests/pr1085-native-app.html')
      await wc.debugger.sendCommand('DOM.setFileInputFiles', {
        files: [selected],
        backendNodeId: events.at(-1).backendNodeId,
      })
      const calls = await waitFor(
        () => wc.executeJavaScript('window.__replaceCalls'),
        'Replace mutation'
      )
      assert.deepEqual(calls, [
        ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', path.basename(selected), 'main', 7],
      ])
      assert.deepEqual(await wc.executeJavaScript('window.__replaceGestures'), [
        { trusted: true, active: true },
        { trusted: true, active: true },
      ])
      assert.equal(await wc.executeJavaScript('window.__replaceInputClicks'), 2)
      assert.equal(
        (await wc.executeJavaScript('window.__selectedFile')).size,
        fs.statSync(selected).size
      )
      assert.equal(
        await waitFor(
          () => wc.executeJavaScript('window.__selectedFileText'),
          'selected replacement contents'
        ),
        fs.readFileSync(selected, 'utf8')
      )
      assert.equal(events.length, before + 1)
      console.log(
        'PASS: Replace cancel starts no mutation; fresh gesture sends exact file, target and version'
      )
      return
    }
    if (process.env.PR1085_HOLD_FOLDER === '1') {
      await wc.executeJavaScript('window.__holdFolder = true')
    }
    await wc.executeJavaScript(`(() => {
      window.__chooserCancelEvents = 0
      window.__fileInputClicks = 0
      document.addEventListener('cancel', e => {
        if (e.target instanceof HTMLInputElement && e.target.type === 'file') { window.__chooserCancelEvents++; window.__chooserCancelTrusted = e.isTrusted }
      }, true)
      document.addEventListener('click', e => {
        if (e.target.closest('[data-gfs-action="upload-file"]')) { window.__uploadGesture = { trusted: e.isTrusted, active: navigator.userActivation.isActive }; window.__originalUploadEvent = e }
        if (e.target instanceof HTMLInputElement && e.target.type === 'file') { window.__fileInputClicks++; window.__inputGesture = { active: navigator.userActivation.isActive, duringOriginalDispatch: window.__originalUploadEvent?.eventPhase !== 0 } }
      }, true)
      const row = [...document.querySelectorAll('.da-file-explorer__row')].find(e => e.textContent.includes('Upload folder'))
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 140 }))
    })()`)
    const point = await waitFor(
      () =>
        wc.executeJavaScript(`(() => {
      const el = document.querySelector('[data-gfs-action="upload-file"]')
      if (!el || el.disabled) return null
      const r = el.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }
    })()`),
      'Upload action'
    )
    wc.sendInputEvent({ type: 'mouseMove', ...point })
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await waitFor(() => wc.executeJavaScript('window.__uploadGesture'), 'trusted Upload click')
    assert.deepEqual(await wc.executeJavaScript('window.__uploadGesture'), {
      trusted: true,
      active: true,
    })
    if (process.env.PR1085_CANCEL_CHOOSER === '1') {
      await waitFor(
        () => wc.executeJavaScript('window.__chooserCancelEvents === 1'),
        'chooser cancel event'
      )
      assert.equal(await wc.executeJavaScript('window.__chooserCancelTrusted'), true)
      assert.equal(await wc.executeJavaScript('window.__fileInputClicks'), 1)
      assert.equal(await wc.executeJavaScript('(window.__uploadCreates ?? []).length'), 0)
      await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', {
        enabled: true,
        cancel: false,
      })
      await wc.executeJavaScript(`(() => {
        const row = [...document.querySelectorAll('.da-file-explorer__row')].find(e => e.textContent.includes('Upload folder'))
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 140 }))
      })()`)
      const retryPoint = await waitFor(
        () =>
          wc.executeJavaScript(`(() => {
        const el = document.querySelector('[data-gfs-action="upload-file"]')
        if (!el || el.disabled) return null
        const r = el.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }
      })()`),
        'fresh Upload action'
      )
      const eventsBeforeRetry = events.length
      wc.sendInputEvent({ type: 'mouseMove', ...retryPoint })
      wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...retryPoint })
      wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...retryPoint })
      await waitFor(() => events.length > eventsBeforeRetry, 'fresh chooser after cancel')
      assert.equal(events.length, eventsBeforeRetry + 1, 'one chooser for the fresh gesture')
      const selected = path.resolve('ui/native-tests/pr1085-native-app.html')
      await wc.debugger.sendCommand('DOM.setFileInputFiles', {
        files: [selected],
        backendNodeId: events.at(-1).backendNodeId,
      })
      const created = await waitFor(
        () => wc.executeJavaScript('window.__uploadCreate'),
        'fresh upload creation'
      )
      assert.equal(created[0], 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      assert.equal(created[1], path.basename(selected))
      assert.equal(created[2], path.basename(selected))
      assert.equal(
        (await wc.executeJavaScript('window.__selectedFile')).size,
        fs.statSync(selected).size
      )
      assert.equal(
        await waitFor(
          () => wc.executeJavaScript('window.__selectedFileText'),
          'selected file contents'
        ),
        fs.readFileSync(selected, 'utf8')
      )
      assert.equal(await wc.executeJavaScript('window.__fileInputClicks'), 2)
      assert.equal(await wc.executeJavaScript('window.__uploadCreates.length'), 1)
      assert.equal(await wc.executeJavaScript('window.__chooserCancelEvents'), 1)
      assert.equal(events.length, eventsBeforeRetry + 1)
      console.log(
        'PASS: intercepted chooser cancel creates nothing; fresh gesture creates on target'
      )
      return
    }
    if (process.env.PR1085_HOLD_FOLDER === '1') {
      await waitFor(
        async () =>
          events.length > 0 || (await wc.executeJavaScript('!navigator.userActivation.isActive')),
        'chooser or activation expiry'
      )
      const selected = path.resolve('ui/native-tests/pr1085-native-app.html')
      if (events.length > 0) {
        assert.equal(events.length, 1, 'one chooser opens before the delayed handoff')
        await wc.debugger.sendCommand('DOM.setFileInputFiles', {
          files: [selected],
          backendNodeId: events[0].backendNodeId,
        })
        await waitFor(
          () => wc.executeJavaScript('window.__folderResolveStarted'),
          'held folder resolve'
        )
        await wc.executeJavaScript('window.__holdFolder = false; window.__releaseFolder()')
        const created = await waitFor(
          () => wc.executeJavaScript('window.__uploadCreate'),
          'delayed upload creation'
        )
        assert.equal(created[0], 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
        assert.equal(created[1], path.basename(selected))
        assert.equal(events.length, 1, 'handoff must not open a second chooser')
        console.log('PASS: one chooser precedes delayed Files handoff and creates on the target')
        return
      }
      await waitFor(
        () => wc.executeJavaScript('window.__folderResolveStarted'),
        'held folder resolve'
      )
      assert.equal(events.length, 0, 'no chooser opened before folder resolution')
      await wc.executeJavaScript('window.__holdFolder = false; window.__releaseFolder()')
      await waitFor(
        () => wc.executeJavaScript('window.__inputGesture'),
        'delayed Upload input click'
      )
      const inputGesture = await wc.executeJavaScript('window.__inputGesture')
      assert.equal(inputGesture.active, false, 'input was reached after activation expired')
      await new Promise(resolve => setTimeout(resolve, 500))
      assert.equal(events.length, 1, 'one usable chooser must open for a delayed Files handoff')
      return
    }
    await waitFor(() => events.length, 'App/Files chooser')
    assert.equal(events.length, 1)
    const selected = path.resolve('ui/native-tests/pr1085-native-app.html')
    if (process.env.PR1085_NAV_BEFORE_SELECT === '1') {
      await wc.executeJavaScript(`(() => {
        const input = document.querySelector('input[aria-label="Upload file"]')
        window.__oldInputChanges = 0
        input.addEventListener('change', () => window.__oldInputChanges++)
        document.querySelector('[data-testid="nav-chat"]').click()
      })()`)
      await waitFor(
        () => wc.executeJavaScript(`!document.querySelector('[aria-label="EvenDrive browser"]')`),
        'Chat navigation'
      )
      await wc.debugger.sendCommand('DOM.setFileInputFiles', {
        files: [selected],
        backendNodeId: events[0].backendNodeId,
      })
      await waitFor(
        () => wc.executeJavaScript('window.__oldInputChanges === 1'),
        'old input selection delivery'
      )
      await wc.executeJavaScript('new Promise(resolve => setTimeout(resolve, 250))')
      assert.equal(await wc.executeJavaScript('window.__uploadCreate ?? null'), null)
      assert.equal(events.length, 1)
      console.log('PASS: selection after navigation did not create a file')
      return
    }
    await wc.debugger.sendCommand('DOM.setFileInputFiles', {
      files: [selected],
      backendNodeId: events[0].backendNodeId,
    })
    const created = await waitFor(
      () => wc.executeJavaScript('window.__uploadCreate'),
      'upload creation'
    )
    console.log(
      'OBSERVED',
      JSON.stringify({
        gesture: await wc.executeJavaScript('window.__inputGesture'),
        created,
        choosers: events.length,
      })
    )
    assert.equal(created[0], 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    assert.equal(created[1], path.basename(selected))
    assert.equal(created[2], path.basename(selected))
    assert.equal(
      (await wc.executeJavaScript('window.__selectedFile')).name,
      path.basename(selected)
    )
    assert.equal(
      (await wc.executeJavaScript('window.__selectedFile')).size,
      fs.statSync(selected).size
    )
    const text = await waitFor(
      () => wc.executeJavaScript('window.__selectedFileText'),
      'selected file contents'
    )
    assert.equal(text, fs.readFileSync(selected, 'utf8'))
    if (process.env.PR1085_ACCEPT_DELAYED_TIMING !== '1') {
      assert.deepEqual(await wc.executeJavaScript('window.__inputGesture'), {
        active: true,
        duringOriginalDispatch: true,
      })
    }
    assert.equal(events.length, 1)
    console.log('PASS: native Upload reaches exact Files creation')
  } catch (error) {
    console.error(error)
    if (window && !window.isDestroyed())
      console.error(
        'STATE',
        await window.webContents
          .executeJavaScript(
            `JSON.stringify({error:window.__nativeAppError,text:document.body.innerText.slice(0,700), gesture:window.__uploadGesture})`
          )
          .catch(() => 'unavailable')
      )
    status = 1
  } finally {
    if (window && !window.isDestroyed()) window.destroy()
    app.exit(status)
  }
})
