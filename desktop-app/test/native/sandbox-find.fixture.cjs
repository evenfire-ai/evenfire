const { app, BrowserWindow, WebContentsView } = require('electron')
const assert = require('node:assert/strict')

function findFinal(webContents, query, options, createResultGate) {
  return new Promise((resolve, reject) => {
    let requestId = null
    const buffered = []
    const timeout = setTimeout(() => {
      webContents.removeListener('found-in-page', listener)
      reject(new Error(`Timed out finding ${JSON.stringify(query)}`))
    }, 5000)
    const finish = result => {
      if (!result.finalUpdate) return
      clearTimeout(timeout)
      webContents.removeListener('found-in-page', listener)
      gate.dispose()
      resolve(result)
    }
    const gate = createResultGate(finish)
    const inspect = result => {
      if (requestId === null) {
        buffered.push(result)
        return
      }
      if (result.requestId !== requestId) return
      gate.accept(result)
    }
    const listener = (_event, result) => inspect(result)
    webContents.on('found-in-page', listener)
    requestId = webContents.findInPage(query, options)
    buffered.splice(0).forEach(inspect)
  })
}

async function loadedView(window, body) {
  const view = new WebContentsView({
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  window.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 500, height: 300 })
  await view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(body)}`)
  return view
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: true, x: -10000, y: -10000, width: 600, height: 400 })
  try {
    const { createSandboxFindResultGate } = await import('../../dist/sandboxFindSession.js')
    let view = await loadedView(window, '<main>invoice invoice receipt</main>')
    const first = await findFinal(
      view.webContents,
      'invoice',
      { forward: true, findNext: true },
      createSandboxFindResultGate
    )
    assert.equal(first.matches, 2, 'fresh find session returns both matches')
    assert.equal(first.activeMatchOrdinal, 1, 'fresh find selects first match')

    const next = await findFinal(
      view.webContents,
      'invoice',
      { forward: true, findNext: false },
      createSandboxFindResultGate
    )
    assert.equal(next.activeMatchOrdinal, 2, 'same-query next advances')
    const previous = await findFinal(
      view.webContents,
      'invoice',
      { forward: false, findNext: false },
      createSandboxFindResultGate
    )
    assert.equal(previous.activeMatchOrdinal, 1, 'previous reverses selection')

    const replacement = await findFinal(
      view.webContents,
      'receipt',
      { forward: true, findNext: true },
      createSandboxFindResultGate
    )
    assert.equal(replacement.matches, 1, 'replacement query starts a fresh session')
    const empty = await findFinal(
      view.webContents,
      'missing',
      { forward: true, findNext: true },
      createSandboxFindResultGate
    )
    assert.equal(empty.matches, 0, 'final zero is reported explicitly')

    view.setVisible(false)
    const hidden = await findFinal(
      view.webContents,
      'invoice',
      { forward: true, findNext: true },
      createSandboxFindResultGate
    )
    assert.equal(hidden.matches, 2, 'hidden active WebContentsView remains searchable')

    view.webContents.stopFindInPage('clearSelection')
    window.contentView.removeChildView(view)
    view.webContents.close()
    view = await loadedView(window, '<main>replacement app value</main>')
    const remounted = await findFinal(
      view.webContents,
      'replacement',
      { forward: true, findNext: true },
      createSandboxFindResultGate
    )
    assert.equal(remounted.matches, 1, 'a remounted view starts independently')
    window.contentView.removeChildView(view)
    view.webContents.close()
    console.log('sandbox find native fixture: PASS')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
