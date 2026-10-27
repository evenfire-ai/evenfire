import { type ReactNode, useSyncExternalStore } from 'react'
import { ConfigProvider, theme as antdTheme } from 'antd'

const subscribeToTheme = (onStoreChange: () => void) => {
  const observer = new MutationObserver(onStoreChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })

  return () => observer.disconnect()
}

const getThemeSnapshot = () =>
  document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'

type AntDesignProviderProps = {
  children: ReactNode
}

export function AntDesignProvider({ children }: AntDesignProviderProps) {
  const mode = useSyncExternalStore(subscribeToTheme, getThemeSnapshot, getThemeSnapshot)

  return (
    <ConfigProvider
      componentSize="small"
      theme={{ algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}
    >
      {children}
    </ConfigProvider>
  )
}
