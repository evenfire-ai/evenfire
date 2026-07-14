export type AdminRole = 'admin'

export type AdminAuthClaims = {
  sub: string
  typ: 'user'
  role: AdminRole
  jti: string
  exp: number
  sessionVersion?: number
}
