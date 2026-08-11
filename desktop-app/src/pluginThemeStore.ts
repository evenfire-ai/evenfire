/**
 * Desktop theme, visible to the main process (spec §6.7).
 *
 * Theme has always lived in the renderer: `App.tsx` reads and writes
 * `localStorage['evenfire.ui.theme']` and stamps `data-theme` on the document.
 * Main had no idea what it was, which `theme.read` and the `theme.changed`
 * event both need.
 *
 * Rather than move ownership wholesale (a migration that would have to reconcile
 * localStorage with a new on-disk file and get the boot ordering right), the
 * renderer stays the writer and main keeps a MIRROR: the renderer pushes the
 * current value on boot and on every change, and main persists the last value
 * so an embed that asks before the renderer has reported gets the right answer
 * instead of a default flash.
 *
 * This is a deliberate narrowing of spec §6.7. The observable contract for
 * plugins is identical; if theme ever needs to be authoritative in main (say a
 * headless surface), this module is where that change lands.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PluginTheme } from './pluginSdkProtocol.js'

const FILE_NAME = 'plugin-sdk-theme.json'
const DEFAULT_THEME: PluginTheme = 'dark'

export class PluginThemeStore {
  private theme: PluginTheme = DEFAULT_THEME
  private loaded = false
  private listeners = new Set<(theme: PluginTheme) => void>()

  constructor(private readonly baseDir: string) {}

  private get file(): string {
    return path.join(this.baseDir, FILE_NAME)
  }

  /** Best-effort hydrate. A missing or unreadable file is simply the default. */
  async load(): Promise<PluginTheme> {
    if (this.loaded) return this.theme
    this.loaded = true
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as { theme?: unknown }
      if (parsed?.theme === 'light' || parsed?.theme === 'dark') this.theme = parsed.theme
    } catch {
      // Default stands.
    }
    return this.theme
  }

  get(): PluginTheme {
    return this.theme
  }

  /** Renderer reported a value. Notifies listeners only on an actual change. */
  set(next: unknown): void {
    const theme: PluginTheme = next === 'light' ? 'light' : next === 'dark' ? 'dark' : DEFAULT_THEME
    if (theme === this.theme && this.loaded) return
    this.theme = theme
    this.loaded = true
    void fs
      .mkdir(this.baseDir, { recursive: true })
      .then(() => fs.writeFile(this.file, JSON.stringify({ theme }), 'utf8'))
      .catch(err => console.warn('[PluginSDK] theme persist failed:', err))
    for (const listener of this.listeners) {
      try {
        listener(theme)
      } catch (err) {
        console.warn('[PluginSDK] theme listener failed:', err)
      }
    }
  }

  onChange(listener: (theme: PluginTheme) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
