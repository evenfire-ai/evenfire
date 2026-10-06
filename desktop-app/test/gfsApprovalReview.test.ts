import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ElectronApplication, Page } from '@playwright/test'
import { existsSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { createGfsApprovalReview } from './e2e-playwright/helpers/gfsApprovalReview'

type Review = Awaited<ReturnType<typeof createGfsApprovalReview>>
const reviews: Review[] = []
const compiledUrl = 'file:///owned/worktree/desktop-app/ui-dist/index.html'
const receiptPath = '.gfs-downloads/input-01234567-89ab-cdef-0123-456789abcdef/source'
const command = `node - <<'NODE'
const fs = require('fs');
const stream = fs.createReadStream(${JSON.stringify(receiptPath)});
stream.resume();
NODE`

afterEach(async () => {
  vi.restoreAllMocks()
  for (const review of reviews.splice(0)) await review.close()
  vi.useRealTimers()
})

/** The transport and DOM adapter execute; only the already-owned Page is doubled. */
function ownedUi() {
  const state = {
    command,
    pid: 101,
    url: compiledUrl,
    closed: false,
    visible: true,
    enabled: true,
    truncated: false,
    shellLabel: 'Shell requires approval',
    disposeThrows: false,
    node: { isConnected: true },
    denyNode: { isConnected: true },
    response: 'Records: 923; all columns listed.',
  }
  const approveClick = vi.fn(async () => {
    state.visible = false
  })
  const denyClick = vi.fn(async () => {
    state.visible = false
  })
  const domCalls: string[] = []
  function locator(id: string): any {
    domCalls.push(id)
    return {
      count: async () =>
        id === 'note'
          ? Number(state.truncated)
          : id === 'agent-response' || id === 'progress-stepper'
            ? 1
            : Number(state.visible),
      isVisible: async () => id === 'agent-response' || state.visible,
      isEnabled: async () => state.enabled,
      innerText: async () =>
        id === 'status'
          ? state.shellLabel
          : id === 'agent-response'
            ? state.response
            : state.command,
      filter: () => locator(id),
      getByTestId: locator,
      getByRole: locator,
      click: denyClick,
      elementHandle: async () => {
        const node = id === 'approval-deny-btn' ? state.denyNode : state.node
        return {
          node,
          evaluate: async (fn: (element: unknown, other: unknown) => unknown, other: any) =>
            fn(node, other.node),
          click: id === 'approval-deny-btn' ? denyClick : approveClick,
          dispose: vi.fn(async () => {
            if (state.disposeThrows) throw new Error('Renderer closed')
          }),
        }
      },
    }
  }
  const page = {
    getByTestId: locator,
    isClosed: () => state.closed,
    url: () => state.url,
    evaluate: () => {
      throw new Error('Hidden renderer API forbidden')
    },
  } as unknown as Page
  const pages = [page]
  const app = {
    process: () => ({ pid: state.pid }),
    context: () => ({ pages: () => pages }),
    evaluate: () => {
      throw new Error('Hidden Electron API forbidden')
    },
  } as unknown as ElectronApplication
  return { state, page, app, pages, approveClick, denyClick, domCalls }
}

async function fixture(options?: Parameters<typeof createGfsApprovalReview>[3]) {
  const ui = ownedUi()
  const review = await createGfsApprovalReview(ui.app, ui.page, compiledUrl, options)
  reviews.push(review)
  return { ...ui, review }
}

async function request(review: Review, value: unknown, raw = false): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(review.socketPath)
    socket.setTimeout(2_000, () => socket.destroy(new Error('Fixture transport timeout')))
    const chunks: Buffer[] = []
    socket.once('error', reject)
    socket.once('connect', () => socket.write(raw ? String(value) : `${JSON.stringify(value)}\n`))
    socket.on('data', chunk => chunks.push(chunk))
    socket.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
  })
}

describe('attended GFS approval reviewer', () => {
  it('creates a private bounded socket and never approves during viewing/preparation', async () => {
    const f = await fixture()
    expect(statSync(dirname(f.review.socketPath)).mode & 0o777).toBe(0o700)
    expect(statSync(f.review.socketPath).mode & 0o777).toBe(0o600)
    expect(await request(f.review, { action: 'view' })).toMatchObject({ state: 'preparing' })
    expect(await request(f.review, { action: 'approve', nonce: 'unknown' })).toHaveProperty('error')
    f.review.activate()
    const view = await request(f.review, { action: 'view' })
    expect(view).toMatchObject({
      state: 'waiting_approval',
      command,
      binding: { pid: 101, url: compiledUrl },
    })
    expect(await request(f.review, { action: 'view' })).toHaveProperty('nonce', view.nonce)
    expect(f.approveClick).not.toHaveBeenCalled()
    expect(f.denyClick).not.toHaveBeenCalled()
    expect(await request(f.review, { action: 'release' })).toHaveProperty('error')
  })

  it('clicks only the exact visible approval button after one explicit decision', async () => {
    const f = await fixture()
    f.review.activate()
    const view = await request(f.review, { action: 'view' })
    expect(await request(f.review, { action: 'approve', nonce: view.nonce })).toMatchObject({
      clicked: 'approve',
    })
    expect(f.approveClick).toHaveBeenCalledExactlyOnceWith({ timeout: expect.any(Number) })
    expect(f.denyClick).not.toHaveBeenCalled()
    expect(f.domCalls).toContain('approval-approve-btn')
    expect(await request(f.review, { action: 'approve', nonce: view.nonce })).toHaveProperty(
      'error'
    )
    expect(f.approveClick).toHaveBeenCalledTimes(1)
  })

  it('requires a fresh explicit decision for every successive visible request', async () => {
    const f = await fixture()
    f.review.activate()
    const first = await request(f.review, { action: 'view' })
    expect(f.approveClick).not.toHaveBeenCalled()
    expect(await request(f.review, { action: 'approve', nonce: first.nonce })).toMatchObject({
      clicked: 'approve',
    })
    expect(f.approveClick).toHaveBeenCalledExactlyOnceWith({ timeout: expect.any(Number) })

    f.state.visible = true
    f.state.command = command.replace(
      'stream.resume();',
      "stream.resume(); if (/^record-/i.test('record')) globalThis.checked = true;"
    )
    const next = await request(f.review, { action: 'view' })
    expect(next.nonce).not.toEqual(first.nonce)
    expect(f.approveClick).toHaveBeenCalledTimes(1)
    expect(await request(f.review, { action: 'approve', nonce: first.nonce })).toHaveProperty(
      'error'
    )
    expect(await request(f.review, { action: 'approve', nonce: next.nonce })).toMatchObject({
      clicked: 'approve',
    })
    expect(f.approveClick).toHaveBeenCalledTimes(2)
    expect(f.denyClick).not.toHaveBeenCalled()
  })

  it.each([
    'command',
    'button',
    'deny button',
    'url',
    'pid',
    'page',
    'closed',
    'truncated',
    'label',
    'disabled',
  ])('rejects a reviewed request whose %s changed before the click', async changed => {
    const f = await fixture()
    f.review.activate()
    const view = await request(f.review, { action: 'view' })
    if (changed === 'command') f.state.command = 'a different command'
    if (changed === 'button') f.state.node = { isConnected: true }
    if (changed === 'deny button') f.state.denyNode = { isConnected: true }
    if (changed === 'url') f.state.url = 'file:///foreign/ui-dist/index.html'
    if (changed === 'pid') f.state.pid++
    if (changed === 'page') f.pages.splice(0)
    if (changed === 'closed') f.state.closed = true
    if (changed === 'truncated') f.state.truncated = true
    if (changed === 'label') f.state.shellLabel = 'Other tool requires approval'
    if (changed === 'disabled') f.state.enabled = false
    expect(await request(f.review, { action: 'approve', nonce: view.nonce })).toHaveProperty(
      'error'
    )
    expect(f.approveClick).not.toHaveBeenCalled()
    expect(f.denyClick).not.toHaveBeenCalled()
  })

  it('requires a fresh nonce for a replacement button with identical command text', async () => {
    const f = await fixture()
    f.review.activate()
    const first = await request(f.review, { action: 'view' })
    f.state.node = { isConnected: true }
    const second = await request(f.review, { action: 'view' })
    expect(second.command).toBe(first.command)
    expect(second.nonce).not.toBe(first.nonce)
    expect(await request(f.review, { action: 'approve', nonce: first.nonce })).toHaveProperty(
      'error'
    )
    expect(f.approveClick).not.toHaveBeenCalled()
    expect(await request(f.review, { action: 'approve', nonce: second.nonce })).toMatchObject({
      clicked: 'approve',
    })
    expect(f.approveClick).toHaveBeenCalledTimes(1)
  })

  it('consumes a nonce before awaiting the UI so simultaneous decisions cannot click twice', async () => {
    const f = await fixture()
    f.review.activate()
    const view = await request(f.review, { action: 'view' })
    let finish!: () => void
    f.approveClick.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    const first = request(f.review, { action: 'approve', nonce: view.nonce })
    await vi.waitFor(() => expect(f.approveClick).toHaveBeenCalledTimes(1))
    expect(await request(f.review, { action: 'approve', nonce: view.nonce })).toHaveProperty(
      'error'
    )
    finish()
    expect(await first).toMatchObject({ clicked: 'approve' })
    expect(f.approveClick).toHaveBeenCalledTimes(1)
  })

  it('denies through the visible UI and never activates approval', async () => {
    const f = await fixture()
    f.review.activate()
    const view = await request(f.review, { action: 'view' })
    expect(await request(f.review, { action: 'deny', nonce: view.nonce })).toMatchObject({
      clicked: 'deny',
    })
    expect(f.denyClick).toHaveBeenCalledExactlyOnceWith({ timeout: expect.any(Number) })
    expect(f.approveClick).not.toHaveBeenCalled()
    expect(await request(f.review, { action: 'deny', nonce: view.nonce })).toHaveProperty('error')
    expect(f.denyClick).toHaveBeenCalledTimes(1)
  })

  it('rejects denial after its reviewed DOM button is replaced', async () => {
    const f = await fixture()
    f.review.activate()
    const view = await request(f.review, { action: 'view' })
    f.state.denyNode = { isConnected: true }
    expect(await request(f.review, { action: 'deny', nonce: view.nonce })).toHaveProperty('error')
    expect(f.denyClick).not.toHaveBeenCalled()
    expect(f.approveClick).not.toHaveBeenCalled()
  })

  it.each(['approve', 'deny'])(
    'refuses %s when its remaining click deadline reaches zero',
    async action => {
      const f = await fixture()
      f.review.activate()
      const view = await request(f.review, { action: 'view' })
      const start = view.expiresAt - 120_000
      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(start) // Request is still current.
        .mockReturnValueOnce(start) // Start the five-second UI decision deadline.
        .mockReturnValue(start + 5_000) // Validation consumed the entire deadline.
      expect(await request(f.review, { action, nonce: view.nonce })).toEqual({
        error: 'Review decision expired before click',
      })
      expect(f.approveClick).not.toHaveBeenCalled()
      expect(f.denyClick).not.toHaveBeenCalled()
    }
  )

  it.each([
    { action: 'approve', nonce: 'wrong' },
    { action: 'alwaysApprove' },
    { action: 'approve', nonce: 1 },
    { action: 'view', nonce: 'unexpected' },
    { action: 'view', hiddenApi: 'approve' },
    [],
    null,
  ])('rejects invalid decisions without a click: %j', async value => {
    const f = await fixture()
    f.review.activate()
    await request(f.review, { action: 'view' })
    expect(await request(f.review, value)).toHaveProperty('error')
    expect(f.approveClick).not.toHaveBeenCalled()
  })

  it('bounds input bytes, visible commands and request lifetime', async () => {
    const f = await fixture({ requestTimeoutMs: 5 })
    f.review.activate()
    expect(await request(f.review, `${'x'.repeat(1_025)}\n`, true)).toHaveProperty('error')
    expect(await request(f.review, '{}\n{}\n', true)).toHaveProperty('error')
    expect(await request(f.review, 'not-json\n', true)).toEqual({ error: 'Invalid review request' })
    f.state.command = 'x'.repeat(65_537)
    expect(await request(f.review, { action: 'view' })).toHaveProperty('error')
    f.state.command = command
    const view = await request(f.review, { action: 'view' })
    vi.spyOn(Date, 'now').mockReturnValue(view.expiresAt + 1)
    expect(await request(f.review, { action: 'approve', nonce: view.nonce })).toHaveProperty(
      'error'
    )
    vi.restoreAllMocks()
    expect(f.approveClick).not.toHaveBeenCalled()
  })

  it('observes actual pass/fail until release, without treating release as success', async () => {
    const f = await fixture()
    const capturedVisibleResponse = f.state.response
    const observation = f.review.observeResult('failed', capturedVisibleResponse)
    f.state.response = 'Files page after navigation'
    expect(await request(f.review, { action: 'view' })).toMatchObject({
      state: 'result',
      result: 'failed',
      response: capturedVisibleResponse,
    })
    expect(await request(f.review, { action: 'release' })).toMatchObject({
      released: true,
      result: 'failed',
    })
    await observation
    expect(f.approveClick).not.toHaveBeenCalled()
    await f.review.close()
    reviews.splice(reviews.indexOf(f.review), 1)
    expect(existsSync(dirname(f.review.socketPath))).toBe(false)
  })

  it('ends result observation at a bounded deadline', async () => {
    const f = await fixture({ resultTimeoutMs: 5 })
    vi.useFakeTimers()
    const observation = f.review.observeResult('passed')
    await vi.advanceTimersByTimeAsync(5)
    await observation
    expect(f.approveClick).not.toHaveBeenCalled()
  })

  it('cleans up the socket even if a closed page cannot dispose its last button', async () => {
    const f = await fixture()
    f.review.activate()
    await request(f.review, { action: 'view' })
    // Model a disappeared renderer through its DOM handle, without launching one.
    f.state.disposeThrows = true
    await expect(f.review.close()).rejects.toThrow('Renderer closed')
    reviews.splice(reviews.indexOf(f.review), 1)
    expect(existsSync(dirname(f.review.socketPath))).toBe(false)
  })
})
