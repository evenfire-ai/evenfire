import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserContextManager } from './browserContext'

// Use vi.hoisted so these are available in the vi.mock factory
const { mockPage, mockContext, mockBrowser } = vi.hoisted(() => {
  const mockPage = {
    goto: vi.fn(),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
    click: vi.fn(),
    fill: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    title: vi.fn().mockResolvedValue('Test Page'),
    textContent: vi.fn().mockResolvedValue('text'),
    content: vi.fn().mockResolvedValue('<html></html>'),
    getByText: vi.fn().mockReturnValue({ click: vi.fn() }),
    close: vi.fn(),
    isClosed: vi.fn().mockReturnValue(false),
  }

  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn(),
  }

  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn().mockResolvedValue(undefined),
  }

  return { mockPage, mockContext, mockBrowser }
})

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  },
}))

describe('BrowserContextManager', () => {
  let manager: BrowserContextManager

  beforeEach(async () => {
    vi.clearAllMocks()
    // Re-wire mocks after clearAllMocks
    const { chromium } = await import('playwright')
    ;(chromium.launch as ReturnType<typeof vi.fn>).mockResolvedValue(mockBrowser)
    mockBrowser.newContext.mockResolvedValue(mockContext)
    mockBrowser.close.mockResolvedValue(undefined)
    mockContext.newPage.mockResolvedValue(mockPage)
    ;(mockPage.isClosed as ReturnType<typeof vi.fn>).mockReturnValue(false)
    manager = new BrowserContextManager()
  })

  it('launches browser on first getPage call', async () => {
    const page = await manager.getPage()
    expect(page).toBe(mockPage)
    expect(mockBrowser.newContext).toHaveBeenCalledTimes(1)
  })

  it('reuses same page on subsequent calls', async () => {
    const page1 = await manager.getPage()
    const page2 = await manager.getPage()
    expect(page1).toBe(page2)
    expect(mockBrowser.newContext).toHaveBeenCalledTimes(1)
  })

  it('recovers from a crashed page by launching a new browser', async () => {
    // First call creates page
    const page1 = await manager.getPage()
    expect(page1).toBe(mockPage)

    // Simulate page crash
    ;(mockPage.isClosed as ReturnType<typeof vi.fn>).mockReturnValue(true)

    // Re-wire mocks for the fresh browser (chromium.launch is already mocked)
    const freshPage = { isClosed: vi.fn().mockReturnValue(false) }
    const freshContext = { newPage: vi.fn().mockResolvedValue(freshPage), close: vi.fn() }
    const freshBrowser = {
      newContext: vi.fn().mockResolvedValue(freshContext),
      close: vi.fn().mockResolvedValue(undefined),
    }
    const { chromium } = await import('playwright')
    ;(chromium.launch as ReturnType<typeof vi.fn>).mockResolvedValue(freshBrowser)

    const page2 = await manager.getPage()
    expect(page2).toBe(freshPage)
    // Old browser should have been closed
    expect(mockBrowser.close).toHaveBeenCalled()
    // New browser was launched
    expect(freshBrowser.newContext).toHaveBeenCalledTimes(1)
  })

  it('closes browser on cleanup', async () => {
    await manager.getPage()
    await manager.cleanup()
    expect(mockBrowser.close).toHaveBeenCalled()
  })
})
