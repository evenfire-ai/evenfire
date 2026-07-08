import type { PasswordLoginResponse } from '@/app/types/api'
import type { Me } from '@/app/types/profile'

export type AuthState = {
  isLoggedIn: boolean
  isLoading: boolean
  me: Me | null
}

export type AuthContextValue = {
  authState: AuthState
  login: (email: string, password: string) => Promise<PasswordLoginResponse>
  logout: () => void
  checkAuth: () => Promise<void>
}
