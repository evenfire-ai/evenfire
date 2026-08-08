import '@testing-library/jest-dom/vitest'

function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key: string) {
      return store.get(key) ?? null
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null
    },
    removeItem(key: string) {
      store.delete(key)
    },
    setItem(key: string, value: string) {
      store.set(key, String(value))
    },
  }
}

if (
  typeof window !== 'undefined' &&
  (typeof window.localStorage?.getItem !== 'function' ||
    typeof window.localStorage?.setItem !== 'function' ||
    typeof window.localStorage?.removeItem !== 'function' ||
    typeof window.localStorage?.clear !== 'function')
) {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: createMemoryStorage(),
  })
}
