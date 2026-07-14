import { createContext, useContext } from 'react'
import type { AuthContextValue } from './AuthContext.types'

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuthContext must be used within AuthContext.Provider')
  return ctx
}

export { AuthContext }
export type { AuthContextValue }
