import { Browser, BrowserContext, Page, chromium } from 'playwright'

/** Singleton instance — shared across all tasks to avoid spawning multiple Chromium windows. */
let singletonInstance: BrowserContextManager | null = null

export class BrowserContextManager {
  /**
   * Get the shared singleton instance. All tasks reuse the same browser.
   */
  static getInstance(): BrowserContextManager {
    if (!singletonInstance) {
      singletonInstance = new BrowserContextManager()
    }
    return singletonInstance
  }
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null

  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page

    // Clean up old browser if it exists (e.g. page crashed)
    if (this.browser) {
      await this.browser.close().catch(() => {})
      this.browser = null
      this.context = null
      this.page = null
    }

    // Launch fresh — headless: false so the browser is visible on the XFCE desktop
    const launchOptions: Record<string, unknown> = {
      headless: false,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--start-maximized'],
    }
    // Use system-installed Chromium when available (Docker desktop image)
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    }
    this.browser = await chromium.launch(launchOptions)
    this.context = await this.browser.newContext({
      viewport: null, // Use the actual window size (maximized on desktop)
    })
    this.page = await this.context.newPage()
    return this.page
  }

  async cleanup(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      this.browser = null
      this.context = null
      this.page = null
    }
  }
}
