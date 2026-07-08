'use client'

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'

type ThemeMode = 'dark' | 'light'

type ThemeContextValue = {
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => void
  toggleTheme: () => void
}

const THEME_STORAGE_KEY = 'clerum.control-ui.theme'

const ThemeContext = createContext<ThemeContextValue | null>(null)

function resolvePreferredThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'dark'
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {
    // Ignore storage failures in restricted environments.
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Keep server and first client render aligned to avoid hydration mismatch.
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark')

  useEffect(() => {
    setThemeMode(resolvePreferredThemeMode())
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeMode)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode)
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }, [themeMode])

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeMode,
      setThemeMode,
      toggleTheme: () => setThemeMode(mode => (mode === 'dark' ? 'light' : 'dark')),
    }),
    [themeMode]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}
