function enabled(value: unknown): boolean {
  return /^true$/i.test(String(value || '').trim())
}

// UI-only opt-in gates. The routes, views, handlers, and APIs remain available
// while the corresponding navigation/composer entry points are hidden.
export const SHOW_AGENT_FILES_UI = enabled(import.meta.env.VITE_SHOW_AGENT_FILES_UI)
export const SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM = enabled(
  import.meta.env.VITE_SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM
)
