import fs from 'fs'

declare function login(): void

export function requireValidExternalSessionToken(
  _req: unknown,
  _res: unknown,
  next: () => void,
) {
  login()
  next()
}

export function requireValidExternalSessionTokenWithPublicErrors(
  _req: unknown,
  _res: unknown,
  next: () => void,
) {
  login()
  next()
}

export function requireExternalSessionRateLimitContext(_options: unknown) {
  return (_req: unknown, _res: unknown, next: () => void) => {
    login()
    next()
  }
}

export function requireExternalTeamParamMatch(
  _req: unknown,
  _res: unknown,
  next: () => void,
) {
  fs.writeFileSync('/tmp/evenfire-codeql-team-match', 'value')
  next()
}
