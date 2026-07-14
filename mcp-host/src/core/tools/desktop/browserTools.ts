import { Tool } from '../../interfaces'
import { ToolOutput } from '../../types'
import { BrowserContextManager } from './browserContext'
import { createScreenshotAttachmentFromBuffer } from './screenshotUtil'

async function takePageScreenshot(
  manager: BrowserContextManager,
  toolName: string
): Promise<ToolOutput['attachments']> {
  const page = await manager.getPage()
  const buffer = await page.screenshot({ type: 'png' })
  return [createScreenshotAttachmentFromBuffer(Buffer.from(buffer), toolName)]
}

export class BrowserOpenTool implements Tool {
  constructor(private readonly manager: BrowserContextManager) {}
  name() {
    return 'browser_open'
  }
  description() {
    return 'Open a URL in the browser. Returns the page title and a screenshot.'
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open' } },
      required: ['url'],
    }
  }
  requiresSanitization() {
    return false
  }
  requiresApproval() {
    return true
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    try {
      const page = await this.manager.getPage()
      await page.goto(params.url as string, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      const title = await page.title()
      const attachments = await takePageScreenshot(this.manager, 'browser_open')
      return {
        content: `Opened: ${title}`,
        duration_ms: Date.now() - start,
        is_error: false,
        attachments,
      }
    } catch (err) {
      return {
        content: `Failed to open URL: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }
}

export class BrowserScreenshotTool implements Tool {
  constructor(private readonly manager: BrowserContextManager) {}
  name() {
    return 'browser_screenshot'
  }
  description() {
    return 'Take a screenshot of the current browser page.'
  }
  parametersSchema() {
    return { type: 'object', properties: {} }
  }
  requiresSanitization() {
    return false
  }
  requiresApproval() {
    return false
  }

  async execute(_params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    try {
      const attachments = await takePageScreenshot(this.manager, 'browser_screenshot')
      return {
        content: 'Browser screenshot captured',
        duration_ms: Date.now() - start,
        is_error: false,
        attachments,
      }
    } catch (err) {
      return {
        content: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }
}

export class BrowserClickTool implements Tool {
  constructor(private readonly manager: BrowserContextManager) {}
  name() {
    return 'browser_click'
  }
  description() {
    return 'Click an element in the browser by CSS selector or visible text.'
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to click' },
        text: { type: 'string', description: 'Visible text to click (alternative to selector)' },
      },
    }
  }
  requiresSanitization() {
    return false
  }
  requiresApproval() {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    try {
      const page = await this.manager.getPage()
      if (params.selector) {
        await page.click(params.selector as string)
      } else if (params.text) {
        await page.getByText(params.text as string).click()
      } else {
        return {
          content: 'Either selector or text is required',
          duration_ms: Date.now() - start,
          is_error: true,
        }
      }
      const attachments = await takePageScreenshot(this.manager, 'browser_click')
      return {
        content: `Clicked ${params.selector || params.text}`,
        duration_ms: Date.now() - start,
        is_error: false,
        attachments,
      }
    } catch (err) {
      return {
        content: `Click failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }
}

export class BrowserTypeTool implements Tool {
  constructor(private readonly manager: BrowserContextManager) {}
  name() {
    return 'browser_type'
  }
  description() {
    return 'Type text into an input field identified by CSS selector.'
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['selector', 'text'],
    }
  }
  requiresSanitization() {
    return true
  }
  requiresApproval() {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    try {
      const page = await this.manager.getPage()
      await page.fill(params.selector as string, params.text as string)
      return {
        content: `Typed into ${params.selector}`,
        duration_ms: Date.now() - start,
        is_error: false,
      }
    } catch (err) {
      return {
        content: `Type failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }
}

export class BrowserNavigateTool implements Tool {
  constructor(private readonly manager: BrowserContextManager) {}
  name() {
    return 'browser_navigate'
  }
  description() {
    return 'Navigate the browser: go back, forward, reload, or to a specific URL.'
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['back', 'forward', 'reload'],
          description: 'Navigation action',
        },
        url: { type: 'string', description: 'URL to navigate to (alternative to action)' },
      },
    }
  }
  requiresSanitization() {
    return false
  }
  requiresApproval() {
    return true
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    try {
      const page = await this.manager.getPage()
      if (params.url) {
        await page.goto(params.url as string, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      } else if (params.action === 'back') {
        await page.goBack()
      } else if (params.action === 'forward') {
        await page.goForward()
      } else if (params.action === 'reload') {
        await page.reload()
      }
      const title = await page.title()
      const attachments = await takePageScreenshot(this.manager, 'browser_navigate')
      return {
        content: `Navigated: ${title}`,
        duration_ms: Date.now() - start,
        is_error: false,
        attachments,
      }
    } catch (err) {
      return {
        content: `Navigation failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }
}

export class BrowserGetContentTool implements Tool {
  // Cap output to keep tool results under LLM rate-limit bucket size.
  // Full-page HTML on a modern site (e.g. x.com) is routinely 400KB → ~100K tokens,
  // which will eat the whole per-minute budget on lower API tiers.
  private static readonly MAX_CHARS = 20000

  constructor(private readonly manager: BrowserContextManager) {}
  name() {
    return 'browser_get_content'
  }
  description() {
    return 'Get rendered text (not HTML) from the current page, optionally from a CSS selector. Output capped at 20k chars.'
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector (optional — returns body text if omitted)',
        },
      },
    }
  }
  requiresSanitization() {
    return false
  }
  requiresApproval() {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    try {
      const page = await this.manager.getPage()
      let content: string
      if (params.selector) {
        content = (await page.textContent(params.selector as string)) || ''
      } else {
        content = await page.innerText('body')
      }
      if (content.length > BrowserGetContentTool.MAX_CHARS) {
        const truncated = content.length - BrowserGetContentTool.MAX_CHARS
        content =
          content.slice(0, BrowserGetContentTool.MAX_CHARS) + `\n\n[truncated ${truncated} chars]`
      }
      return { content, duration_ms: Date.now() - start, is_error: false }
    } catch (err) {
      return {
        content: `Get content failed: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }
}
