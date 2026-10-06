// E2E_GUARDIAN_IPC_FLOW: this test-only controller observes the owned Desktop
// DOM and clicks its visible per-request button. It never calls product APIs.
import type { ElectronApplication, ElementHandle, Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Button = ElementHandle<HTMLElement | SVGElement>
type Pending = {
  nonce: string
  command: string
  button: Button
  denyButton: Button
  expiresAt: number
}
const MAX_REQUEST_BYTES = 1_024
const MAX_COMMAND_BYTES = 65_536
const ALLOWED_NODE_MODULE_ROOT = '/app/mcp-host/node_modules/'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function assertReadonlyReceiptCommand(command: string, receiptPath: string): void {
  if (!command.includes(receiptPath))
    throw new Error('Reviewed command does not use the verified receipt')
  if (!/^node\s+-\s*<<'NODE'\n/.test(command))
    throw new Error('Reviewed command must be a Node stdin program')
  const receiptMatches = command.match(new RegExp(escapeRegExp(receiptPath), 'g')) ?? []
  if (receiptMatches.length !== 1 || receiptMatches[0] !== receiptPath)
    throw new Error('Reviewed command must reference exactly one verified receipt')
  if (command.includes('.gfs-download-store'))
    throw new Error('Reviewed command cannot access the download store')
  const forbidden = [
    /\b(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|unlink)\b/,
    /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|truncate(?:Sync)?|rmSync|unlinkSync)\b/,
    /\b(?:child_process|spawnSync|spawn\(|execSync|exec\(|fork\(|forkSync)\b/,
    /\b(?:fetch|axios|XMLHttpRequest|net\.connect|dns\.)\b/,
    /https?:\/\//,
    /\bprocess\.env\b/,
  ]
  if (forbidden.some(pattern => pattern.test(command)))
    throw new Error('Reviewed command contains a forbidden write, process, or network operation')
  for (const match of command.matchAll(/(['"])(\/[^'"\n]+)\1/g)) {
    const value = match[2]
    if (!value.startsWith(ALLOWED_NODE_MODULE_ROOT))
      throw new Error(`Reviewed command contains an unapproved absolute path: ${value}`)
  }
}

/** Only opt-in attended E2E uses this local reviewer transport. */
export async function createGfsApprovalReview(
  app: ElectronApplication,
  page: Page,
  compiledUrl: string,
  options: { requestTimeoutMs?: number; resultTimeoutMs?: number } = {}
) {
  const pid = app.process().pid
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000
  const resultTimeoutMs = options.resultTimeoutMs ?? 60_000
  for (const value of [requestTimeoutMs, resultTimeoutMs])
    if (!Number.isSafeInteger(value) || value <= 0 || value > 420_000)
      throw new Error('Invalid review deadline')
  const binding = { pid, url: compiledUrl }
  function verifyOwnedPage() {
    if (
      !pid ||
      app.process().pid !== pid ||
      !app.context().pages().includes(page) ||
      page.isClosed() ||
      page.url() !== compiledUrl
    )
      throw new Error('Owned compiled Desktop page changed')
  }
  verifyOwnedPage()
  const directory = await mkdtemp(join(tmpdir(), 'gfs-review-'))
  await chmod(directory, 0o700)
  const socketPath = join(directory, 'review.sock')
  const sockets = new Set<Socket>()
  let pending: Pending | undefined
  let deciding = false
  let active = false
  let result: 'passed' | 'failed' | undefined
  let resultResponse: string | undefined
  let releaseResult: (() => void) | undefined

  async function visibleApproval() {
    verifyOwnedPage()
    const approve = page.getByTestId('approval-approve-btn')
    if ((await approve.count()) === 0) return undefined
    if (
      (await approve.count()) !== 1 ||
      !(await approve.isVisible()) ||
      !(await approve.isEnabled())
    )
      throw new Error('One actionable visible approval is required')
    const stepper = page.getByTestId('progress-stepper').filter({ has: approve })
    const preview = stepper.getByTestId('approval-input-preview')
    if (
      (await stepper.count()) !== 1 ||
      !(await stepper.isVisible()) ||
      (await stepper.getByRole('status').innerText()).trim() !== 'Shell requires approval' ||
      (await preview.count()) !== 1 ||
      !(await preview.isVisible()) ||
      (await stepper.getByRole('note').count()) !== 0
    )
      throw new Error('Complete visible shell preview required')
    const command = await preview.innerText()
    if (!command || Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES)
      throw new Error('Visible shell command exceeds review bound')
    const deny = stepper.getByTestId('approval-deny-btn')
    if ((await deny.count()) !== 1 || !(await deny.isVisible()) || !(await deny.isEnabled()))
      throw new Error('One actionable visible denial is required')
    const button = await approve.elementHandle()
    const denyButton = await deny.elementHandle()
    if (!button || !denyButton) {
      await button?.dispose()
      await denyButton?.dispose()
      throw new Error('Visible decision button disappeared')
    }
    return { command, button, denyButton }
  }

  async function sameButton(button: Button, current: Button): Promise<boolean> {
    return button.evaluate((node, other) => node.isConnected && node === other, current)
  }

  async function disposeButtons(snapshot?: { button: Button; denyButton: Button }) {
    if (snapshot) await Promise.all([snapshot.button.dispose(), snapshot.denyButton.dispose()])
  }

  async function inspectReview(): Promise<unknown> {
    verifyOwnedPage()
    if (result) {
      return {
        state: 'result',
        result,
        binding,
        ...(resultResponse !== undefined ? { response: resultResponse } : {}),
      }
    }
    if (!active) return { state: 'preparing', binding }
    if (deciding) return { state: 'deciding', binding }
    const current = await visibleApproval()
    if (!current) {
      await disposeButtons(pending)
      pending = undefined
      return { state: 'running', binding }
    }
    if (
      !pending ||
      pending.command !== current.command ||
      Date.now() >= pending.expiresAt ||
      !(await sameButton(pending.button, current.button)) ||
      !(await sameButton(pending.denyButton, current.denyButton))
    ) {
      await disposeButtons(pending)
      pending = {
        nonce: randomUUID(),
        command: current.command,
        button: current.button,
        denyButton: current.denyButton,
        expiresAt: Date.now() + requestTimeoutMs,
      }
    } else await disposeButtons(current)
    return {
      state: 'waiting_approval',
      binding,
      nonce: pending.nonce,
      command: pending.command,
      expiresAt: pending.expiresAt,
    }
  }

  async function reviewAndApproveVisible(receiptPath: string): Promise<boolean> {
    verifyOwnedPage()
    if (!active || result || deciding) return false
    const approve = page.getByTestId('approval-approve-btn')
    const approveCount = await approve.count()
    if (approveCount === 0) return false
    if (approveCount !== 1 || !(await approve.isVisible()) || !(await approve.isEnabled()))
      return false
    const current = await visibleApproval()
    if (!current) return false
    assertReadonlyReceiptCommand(current.command, receiptPath)
    pending = {
      nonce: randomUUID(),
      command: current.command,
      button: current.button,
      denyButton: current.denyButton,
      expiresAt: Date.now() + requestTimeoutMs,
    }
    await decideReview('approve', pending.nonce)
    return true
  }

  async function decideReview(action: 'approve' | 'deny', nonce: unknown): Promise<unknown> {
    if (
      !active ||
      result ||
      deciding ||
      !pending ||
      nonce !== pending.nonce ||
      Date.now() >= pending.expiresAt
    )
      throw new Error('No current unconsumed review request')
    const reviewed = pending
    pending = undefined // Consume once, before any await or UI action.
    deciding = true
    const actionDeadline = Date.now() + 5_000
    let current: Awaited<ReturnType<typeof visibleApproval>>
    try {
      current = await visibleApproval()
      if (
        !current ||
        current.command !== reviewed.command ||
        !(await sameButton(reviewed.button, current.button)) ||
        !(await sameButton(reviewed.denyButton, current.denyButton))
      )
        throw new Error('Reviewed shell command or button changed')
      verifyOwnedPage()
      const remaining = actionDeadline - Date.now()
      if (result || remaining <= 0) throw new Error('Review decision expired before click')
      const decisionButton = action === 'approve' ? reviewed.button : reviewed.denyButton
      await decisionButton.click({ timeout: remaining })
      return { clicked: action, binding }
    } finally {
      deciding = false
      try {
        await disposeButtons(current)
      } finally {
        await disposeButtons(reviewed)
      }
    }
  }

  async function handleRequest(raw: Buffer): Promise<unknown> {
    if (raw.byteLength > MAX_REQUEST_BYTES) throw new Error('Review request exceeds byte bound')
    let request: unknown
    try {
      request = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new Error('Invalid review request')
    }
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('Invalid review request')
    const { action, nonce } = request as Record<string, unknown>
    if (Object.keys(request).some(key => key !== 'action' && key !== 'nonce'))
      throw new Error('Unknown review request field')
    // Each fixed route owns its checks. Selecting an observation route cannot
    // skip the nonce, deadline, binding or DOM checks in the decision route.
    switch (action) {
      case 'release':
        if (!result || nonce !== undefined) throw new Error('No completed result to release')
        releaseResult?.()
        return { released: true, result }
      case 'view':
        if (nonce !== undefined) throw new Error('Invalid view request')
        return inspectReview()
      case 'approve':
        return decideReview('approve', nonce)
      case 'deny':
        return decideReview('deny', nonce)
      default:
        throw new Error('Invalid review decision')
    }
  }

  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    socket.setTimeout(5_000, () => socket.destroy())
    let bytes = Buffer.alloc(0)
    let submitted = false
    const respond = (value: unknown) => socket.end(`${JSON.stringify(value)}\n`)
    socket.on('data', chunk => {
      if (submitted) return
      if (bytes.length + chunk.length > MAX_REQUEST_BYTES) {
        submitted = true
        respond({ error: 'Review request exceeds byte bound' })
        return
      }
      bytes = Buffer.concat([bytes, chunk])
      const newline = bytes.indexOf(0x0a)
      if (newline < 0) return
      submitted = true
      if (newline !== bytes.length - 1) {
        respond({ error: 'One review request per connection required' })
        return
      }
      void handleRequest(bytes.subarray(0, newline)).then(
        value => respond(value),
        error => respond({ error: error instanceof Error ? error.message : 'Review failed' })
      )
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await chmod(socketPath, 0o600)
  } catch (error) {
    server.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return {
    socketPath,
    activate() {
      active = true
    },
    /** Reviews and clicks each actionable visible request for one verified receipt. */
    reviewAndApproveVisible,
    /** Result observation cannot bypass or satisfy the journey's business assertions. */
    async observeResult(verdict: 'passed' | 'failed', visibleResponse?: string) {
      result = verdict
      if (visibleResponse !== undefined && Buffer.byteLength(visibleResponse, 'utf8') <= 16_384)
        resultResponse = visibleResponse
      await disposeButtons(pending)
      pending = undefined
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, resultTimeoutMs)
        releaseResult = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      releaseResult = undefined
    },
    async close() {
      releaseResult?.()
      try {
        await disposeButtons(pending)
      } finally {
        for (const socket of sockets) socket.destroy()
        try {
          await new Promise<void>(resolve => server.close(() => resolve()))
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      }
    },
  }
}
