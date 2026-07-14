import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserContextManager } from './browserContext'
import {
  BrowserClickTool,
  BrowserGetContentTool,
  BrowserNavigateTool,
  BrowserOpenTool,
  BrowserScreenshotTool,
  BrowserTypeTool,
} from './browserTools'

// Mock BrowserContextManager
const mockPage = {
  goto: vi.fn(),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  click: vi.fn(),
  fill: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),
  reload: vi.fn(),
  title: vi.fn().mockResolvedValue('Test Page'),
  textContent: vi.fn().mockResolvedValue('page text'),
  content: vi.fn().mockResolvedValue('<html><body>content</body></html>'),
  innerText: vi.fn().mockResolvedValue('page body text'),
  getByText: vi.fn().mockReturnValue({ click: vi.fn() }),
}

const mockManager = {
  getPage: vi.fn().mockResolvedValue(mockPage),
  cleanup: vi.fn(),
} as unknown as BrowserContextManager

describe('Browser Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockManager.getPage = vi.fn().mockResolvedValue(mockPage)
    mockPage.goto.mockResolvedValue(undefined)
    mockPage.title.mockResolvedValue('Test Page')
    mockPage.screenshot.mockResolvedValue(Buffer.from('fake-png'))
    mockPage.click.mockResolvedValue(undefined)
    mockPage.fill.mockResolvedValue(undefined)
    mockPage.goBack.mockResolvedValue(undefined)
    mockPage.goForward.mockResolvedValue(undefined)
    mockPage.reload.mockResolvedValue(undefined)
    mockPage.textContent.mockResolvedValue('page text')
    mockPage.content.mockResolvedValue('<html><body>content</body></html>')
    mockPage.innerText.mockResolvedValue('page body text')
    mockPage.getByText.mockReturnValue({ click: vi.fn() })
  })

  describe('BrowserOpenTool', () => {
    const tool = new BrowserOpenTool(mockManager)

    it('has correct name', () => {
      expect(tool.name()).toBe('browser_open')
    })

    it('navigates to URL and returns title + screenshot', async () => {
      const result = await tool.execute({ url: 'https://example.com' })
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', expect.any(Object))
      expect(result.content).toContain('Test Page')
      expect(result.attachments).toHaveLength(1)
      expect(result.is_error).toBe(false)
    })
  })

  describe('BrowserScreenshotTool', () => {
    const tool = new BrowserScreenshotTool(mockManager)

    it('captures page screenshot', async () => {
      const result = await tool.execute({})
      expect(mockPage.screenshot).toHaveBeenCalled()
      expect(result.attachments).toHaveLength(1)
    })
  })

  describe('BrowserClickTool', () => {
    const tool = new BrowserClickTool(mockManager)

    it('clicks by selector', async () => {
      const result = await tool.execute({ selector: '#btn' })
      expect(mockPage.click).toHaveBeenCalledWith('#btn')
      expect(result.attachments).toHaveLength(1)
    })

    it('clicks by text', async () => {
      const result = await tool.execute({ text: 'Submit' })
      expect(mockPage.getByText).toHaveBeenCalledWith('Submit')
    })
  })

  describe('BrowserTypeTool', () => {
    const tool = new BrowserTypeTool(mockManager)

    it('fills input by selector', async () => {
      const result = await tool.execute({ selector: '#email', text: 'test@example.com' })
      expect(mockPage.fill).toHaveBeenCalledWith('#email', 'test@example.com')
    })
  })

  describe('BrowserNavigateTool', () => {
    const tool = new BrowserNavigateTool(mockManager)

    it('navigates back', async () => {
      await tool.execute({ action: 'back' })
      expect(mockPage.goBack).toHaveBeenCalled()
    })

    it('navigates to URL', async () => {
      await tool.execute({ url: 'https://other.com' })
      expect(mockPage.goto).toHaveBeenCalledWith('https://other.com', expect.any(Object))
    })
  })

  describe('BrowserGetContentTool', () => {
    const tool = new BrowserGetContentTool(mockManager)

    it('gets rendered body text (not HTML) when no selector', async () => {
      const result = await tool.execute({})
      expect(mockPage.innerText).toHaveBeenCalledWith('body')
      expect(mockPage.content).not.toHaveBeenCalled()
      expect(result.content).toBe('page body text')
    })

    it('gets content by selector', async () => {
      await tool.execute({ selector: '#main' })
      expect(mockPage.textContent).toHaveBeenCalledWith('#main')
    })

    it('truncates output over 20k chars with a marker', async () => {
      const big = 'x'.repeat(25000)
      mockPage.innerText.mockResolvedValueOnce(big)
      const result = await tool.execute({})
      expect(result.content.length).toBeLessThan(big.length)
      expect(result.content).toContain('[truncated 5000 chars]')
    })
  })
})
