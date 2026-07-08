// desktop-app/test/e2e/helpers.ts
import { vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ── 1. Load .env.e2e BEFORE any app imports ──────────────────────────
const envPath = path.resolve(__dirname, '../../.env.e2e')
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim()
    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}

// ── 2. Mock Electron before any app module import ────────────────────
// vi.hoisted ensures the mock state is available when vi.mock factory runs
// (vi.mock is auto-hoisted above normal declarations by vitest)
const testState = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMainMock = {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  }
  return { handlers, ipcMainMock }
})

vi.mock('electron', () => ({
  ipcMain: testState.ipcMainMock,
  app: {
    isReady: () => false,
    getPath: () => path.join(process.cwd(), '.test-data'),
  },
}))

// ── 3. Now safe to import app modules ────────────────────────────────
// (these must be dynamic imports so the mock is in place first)

let service: InstanceType<typeof import('../../src/appService.js').AppService> | null = null

export async function setupHarness(): Promise<void> {
  testState.handlers.clear()
  const { AppService } = await import('../../src/appService.js')
  const { registerIpcHandlers } = await import('../../src/ipc.js')
  service = new AppService()
  registerIpcHandlers(service as never)
}

export async function teardownHarness(): Promise<void> {
  if (service) {
    try {
      await invoke('auth:logout')
    } catch {
      // already logged out or never logged in
    }
  }
  testState.handlers.clear()
  service = null
}

// ── 4. IPC invoke helper ─────────────────────────────────────────────
type SenderSpy = {
  id: number
  send: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  destroyedCallbacks: Array<() => void>
}

function makeTrustedEvent(senderId = 77): { event: Record<string, unknown>; sender: SenderSpy } {
  const destroyedCallbacks: Array<() => void> = []
  const sender: SenderSpy = {
    id: senderId,
    send: vi.fn(),
    once: vi.fn((eventName: string, callback: () => void) => {
      if (eventName === 'destroyed') destroyedCallbacks.push(callback)
    }),
    destroyedCallbacks,
  }
  return {
    event: { senderFrame: { url: 'file:///index.html' }, sender },
    sender,
  }
}

let defaultSender: SenderSpy | null = null

export function getSender(): SenderSpy {
  if (!defaultSender) throw new Error('Call setupHarness() first')
  return defaultSender
}

export async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = testState.handlers.get(channel)
  if (!handler) throw new Error(`No IPC handler registered for channel: ${channel}`)
  if (!defaultSender) {
    const created = makeTrustedEvent()
    defaultSender = created.sender
  }
  const event = { senderFrame: { url: 'file:///index.html' }, sender: defaultSender }
  return handler(event, ...args)
}

export function resetSender(): void {
  defaultSender = null
}

// ── 5. Env helpers ───────────────────────────────────────────────────
export const E2E_EMAIL = process.env.E2E_DEV_LOGIN_EMAIL || 'test@clerum.io'
export const E2E_NAME = process.env.E2E_DEV_LOGIN_NAME || 'Test User'
export const E2E_PASSWORD =
  process.env.E2E_DESKTOP_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme123!'
export const E2E_HOST_REF = process.env.E2E_HOST_REF || 'chatllm'

// ── 6. Polling helper ────────────────────────────────────────────────
export async function waitForIdle(hostRef: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = (await invoke('rpc:getHostStatus', { hostRef })) as {
      agent?: { state?: string }
    }
    if (status?.agent?.state === 'idle') return
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error(`Agent did not reach idle within ${timeoutMs}ms`)
}
