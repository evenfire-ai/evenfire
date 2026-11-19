/**
 * The GFS watch IPC against real Electron: real BrowserWindows loading local
 * pages through the real preload, the real `ipc.ts` handlers, and the real
 * watch client talking to a fake watch over HTTP. Run with
 * `npm run test:native:gfs-watch-ipc` (bundled by scripts/run-native-gfs-watch-ipc.mjs).
 *
 * Covers T-CB47 (owner and frame token across reloads, late and subframe IPC),
 * T-CB56 (renderer crash) and T-CB59 (window close and navigation away).
 */
import { BrowserWindow, type IpcMainInvokeEvent, app, ipcMain } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type GfsWatchLogger, createGfsWatchClient } from '../../src/gfs/watchClient.js'
import { registerGfsWatchIpcHandlers } from '../../src/ipc.js'
import { FakeWatchServer } from '../../testSupport/gfsWatch/fakeWatchServer.js'
import { USER_A, key, signV1SessionToken } from '../../testSupport/gfsWatch/sessionTokens.js'

const PRELOAD = path.join(__dirname, '..', 'preload.js')
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** An Electron event that never arrives fails the fixture instead of hanging it. */
function within<T>(label: string, promise: Promise<T>, maxMs = 10_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), maxMs)
    ),
  ])
}

async function until(label: string, pred: () => boolean, maxMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!pred()) {
    if (Date.now() - started > maxMs) throw new Error(`timed out waiting for: ${label}`)
    await sleep(10)
  }
}

function writePages(dir: string): { watch: string; plain: string } {
  const watch = path.join(dir, 'watch.html')
  const plain = path.join(dir, 'plain.html')
  const frame = path.join(dir, 'frame.html')
  fs.writeFileSync(watch, '<!doctype html><title>watch</title><iframe src="frame.html"></iframe>')
  fs.writeFileSync(frame, '<!doctype html><title>frame</title>')
  fs.writeFileSync(plain, '<!doctype html><title>plain</title>')
  return { watch, plain }
}

/** Every IPC event of a channel can be held, to deliver it after a navigation. */
const held = new Map<
  string,
  Array<{ event: IpcMainInvokeEvent; payload: unknown; run: () => unknown }>
>()
let holdChannel: string | null = null
const realHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = ((channel: string, fn: (event: IpcMainInvokeEvent, payload: unknown) => unknown) =>
  realHandle(channel, (event, payload) => {
    if (holdChannel === channel) {
      holdChannel = null
      return new Promise(resolve => {
        const list = held.get(channel) ?? []
        list.push({ event, payload, run: () => resolve(fn(event, payload)) })
        held.set(channel, list)
      })
    }
    return fn(event, payload)
  })) as typeof ipcMain.handle

async function openWatch(
  win: BrowserWindow,
  keys: string[],
  userId: string,
  frame = win.webContents.mainFrame
) {
  return frame.executeJavaScript(
    `window.clerum.gfsWatch.open(e => (window.__events = window.__events || []).push(e), ${JSON.stringify(
      { keys, userId }
    )}).then(h => { window.__watch = h; return { sessionExpired: h.sessionExpired } })`
  )
}

async function setList(win: BrowserWindow, keys: string[], userId: string) {
  return win.webContents.executeJavaScript(
    `window.__watch.setSubscriptions(${JSON.stringify({ keys, userId })})`
  )
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gfs-watch-native-'))
  const pages = writePages(dir)
  const server = new FakeWatchServer()
  await server.start()
  const logs: string[] = []
  const log: GfsWatchLogger = {
    warn: m => logs.push(`warn ${m}`),
    error: m => logs.push(`error ${m}`),
  }
  const client = createGfsWatchClient({
    baseUrl: () => server.baseUrl,
    log,
    readHopDepth: () => 0,
    onSessionExpiredVerdict: () => undefined,
  })
  registerGfsWatchIpcHandlers(client)
  client.onSessionToken(signV1SessionToken({ userId: USER_A, authGeneration: 1 }))
  await until('ready', () => client.inspect().link.kind === 'Ready')

  const sent = () => [...client.inspect().sent]
  const keys1 = [key('file', 1), key('dir', 2)]
  const keys2 = [key('file', 3)]
  const putsOf = () => server.puts.map(p => p.keys)
  const newWindow = async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // So the subframe also gets the bridge and can try to speak for the window.
        nodeIntegrationInSubFrames: true,
      },
    })
    await win.loadFile(pages.watch)
    return win
  }

  try {
    // ── T-CB47 ────────────────────────────────────────────────────────────────
    const w1 = await newWindow()
    const id1 = w1.webContents.id
    assert.deepEqual(await openWatch(w1, keys1, USER_A), { sessionExpired: false })
    assert.deepEqual(sent(), keys1, 'T-CB47: the first list is accepted')
    const reg1 = client.inspect().owners.get(id1)
    assert.ok(reg1, 'T-CB47: the window is an owner')
    assert.equal(reg1.frameToken, w1.webContents.mainFrame.frameToken)

    // An IPC of the current document that main only processes after the reload.
    holdChannel = 'gfsWatch:setSubscriptions'
    void setList(w1, keys2, USER_A).catch(() => undefined)
    await until('held IPC', () => (held.get('gfsWatch:setSubscriptions')?.length ?? 0) === 1)
    const tokenBefore = w1.webContents.mainFrame.frameToken
    w1.webContents.reload()
    await within(
      'w1 reload',
      new Promise<void>(resolve => w1.webContents.once('did-finish-load', () => resolve()))
    )
    const tokenAfter = w1.webContents.mainFrame.frameToken
    assert.notEqual(tokenAfter, tokenBefore, 'Electron: a reload changes mainFrame.frameToken')
    const afterReload = client.inspect().owners
    assert.equal(afterReload.size, 1, 'T-CB47: one owner after the reload')
    assert.equal(afterReload.get(id1)?.regOrder, reg1.regOrder, 'T-CB47: same registration order')
    assert.equal(afterReload.get(id1)?.frameToken, tokenAfter, 'T-CB47: the new frame token')
    assert.deepEqual(sent(), [], 'did-navigate empties the list')

    const late = held.get('gfsWatch:setSubscriptions')!.shift()!
    const lateSenderToken = (() => {
      try {
        return late.event.senderFrame?.frameToken ?? null
      } catch {
        return 'throws'
      }
    })()
    // Electron resolves `senderFrame` lazily: after the navigation it is null,
    // so the trusted-sender check refuses the late IPC before the token check.
    let lateOutcome = 'accepted'
    try {
      late.run()
    } catch (error) {
      lateOutcome = (error as Error).message
    }
    await sleep(50)
    assert.equal(
      lateSenderToken,
      null,
      'Electron: a late IPC has no senderFrame after the navigation'
    )
    assert.equal(lateOutcome, 'Untrusted IPC sender')
    assert.deepEqual(sent(), [], 'T-CB47: the late IPC of the old document is dropped')

    assert.deepEqual(await openWatch(w1, keys1, USER_A), { sessionExpired: false })
    assert.deepEqual(sent(), keys1, 'T-CB47: the new document is accepted')
    await w1.webContents.executeJavaScript('window.__watch.close()')
    assert.deepEqual(sent(), [], 'stop empties the list')
    assert.equal(
      client.inspect().owners.get(id1)?.frameToken,
      tokenAfter,
      'stop keeps the frame token'
    )
    assert.deepEqual(await openWatch(w1, keys2, USER_A), { sessionExpired: false })
    assert.deepEqual(sent(), keys2, 'T-CB47: the same document subscribes again after stop')

    const subframe = w1.webContents.mainFrame.frames[0]
    assert.ok(subframe, 'the page has a subframe')
    await openWatch(w1, [key('file', 7)], USER_A, subframe)
    assert.deepEqual(sent(), keys2, 'T-CB47: an IPC from a subframe is dropped')
    assert.equal(client.inspect().owners.size, 1)

    // ── T-CB56 ────────────────────────────────────────────────────────────────
    const w2 = await newWindow()
    const id2 = w2.webContents.id
    await openWatch(w2, keys1, USER_A)
    assert.deepEqual(new Set(sent()), new Set([...keys2, ...keys1]))
    let readInEvent: 'threw' | 'read' | null = null
    const gone = new Promise<void>(resolve =>
      w2.webContents.once('render-process-gone', () => {
        try {
          void w2.webContents.mainFrame.frameToken
          readInEvent = 'read'
        } catch {
          readInEvent = 'threw'
        }
        resolve()
      })
    )
    w2.webContents.forcefullyCrashRenderer()
    await within('render-process-gone listeners', gone)
    await sleep(50)
    assert.equal(
      readInEvent,
      'threw',
      'Electron: mainFrame.frameToken throws in render-process-gone'
    )
    assert.deepEqual(client.inspect().owners.get(id2), {
      frameToken: null,
      regOrder: client.inspect().owners.get(id2)?.regOrder,
      keys: [],
    })
    assert.deepEqual(sent(), keys2, 'T-CB56: the crashed window keys leave sent')
    await until('PUT without the crashed keys', () => server.current()?.keys.size === 1)

    w2.webContents.reload()
    await within(
      'w2 reload',
      new Promise<void>(resolve => w2.webContents.once('did-finish-load', () => resolve()))
    )
    assert.equal(client.inspect().owners.get(id2)?.frameToken, w2.webContents.mainFrame.frameToken)
    await openWatch(w2, keys1, USER_A)
    assert.deepEqual(
      new Set(sent()),
      new Set([...keys2, ...keys1]),
      'T-CB56: accepted after navigation'
    )

    // ── T-CB59 ────────────────────────────────────────────────────────────────
    await until('both lists acked', () => server.current()?.keys.size === 3)
    let sentAtDestroyed: string[] | null = null
    const destroyed = new Promise<void>(resolve =>
      w2.webContents.once('destroyed', () => {
        sentAtDestroyed = sent()
        resolve()
      })
    )
    w2.close()
    await within('destroyed listeners', destroyed)
    assert.deepEqual(sentAtDestroyed, keys2, 'T-CB59: same tick, sent without the closed window')
    await until('PUT without the closed window', () => {
      const last = putsOf().at(-1)
      return !!last && last.length === 1 && last[0] === keys2[0]
    })

    const putsBeforeNav = server.puts.length
    await w1.loadFile(pages.plain)
    assert.deepEqual(sent(), [], 'T-CB59: a page without the watch leaves sent empty')
    await until('PUT with nothing', () => putsOf().at(-1)?.length === 0)
    assert.ok(server.puts.length > putsBeforeNav)

    await w1.loadFile(pages.watch)
    await openWatch(w1, keys2, USER_A)
    await until('PUT with keys2', () => putsOf().at(-1)?.[0] === keys2[0])
    const putsBeforeReload = server.puts.length
    w1.webContents.reload()
    await within(
      'w1 reload',
      new Promise<void>(resolve => w1.webContents.once('did-finish-load', () => resolve()))
    )
    await openWatch(w1, keys2, USER_A)
    await until('two PUTs around the reload', () => server.puts.length >= putsBeforeReload + 2)
    assert.deepEqual(
      putsOf().slice(putsBeforeReload, putsBeforeReload + 2),
      [[], keys2],
      'T-CB59: a reload with the same list costs one PUT without it and one with it'
    )

    const lastClosed = new Promise<void>(resolve =>
      w1.webContents.once('destroyed', () => resolve())
    )
    w1.close()
    await within('last window destroyed', lastClosed)
    await sleep(50)
    assert.deepEqual(sent(), [], 'T-CB59: no windows, nothing watched')
    assert.equal(client.inspect().link.kind, 'Ready', 'T-CB59: the stream stays open')
    assert.equal(server.openStreams().length, 1)
    assert.equal(client.inspect().owners.size, 0)
    assert.deepEqual(
      logs.filter(l => l.includes('entry point failed')),
      [],
      'no entry point threw'
    )
    console.log('gfs watch IPC native fixture: PASS')
  } finally {
    client.dispose()
    await server.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

app.on('window-all-closed', () => undefined)
// Electron shows a blocking dialog for an uncaught main-process error; a test
// must fail with the error instead.
process.on('uncaughtException', error => {
  console.error('gfs watch IPC native fixture: uncaught', error)
  app.exit(1)
})
setTimeout(() => {
  console.error('gfs watch IPC native fixture: timed out')
  app.exit(1)
}, 120_000).unref()
app
  .whenReady()
  .then(main)
  .then(
    () => app.exit(0),
    error => {
      console.error(error)
      app.exit(1)
    }
  )
