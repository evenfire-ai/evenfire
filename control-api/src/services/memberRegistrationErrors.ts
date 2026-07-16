// Typed member-registration failures (spec §8.6). Routes rethrow these ahead of
// their bare 400 catch-alls; the app.ts error middleware maps them to 503.
export class MemberRegistrationUnavailableError extends Error {
  readonly code = 'member_registration_unavailable' as const
  constructor(message = 'member registration is temporarily unavailable') {
    super(message)
    this.name = 'MemberRegistrationUnavailableError'
  }
}

export class MemberRegistrationMisconfiguredError extends Error {
  readonly code = 'member_registration_misconfigured' as const
  constructor(message: string) {
    super(message)
    this.name = 'MemberRegistrationMisconfiguredError'
  }
}

export function memberRegistrationErrorResponse(
  err: unknown
): { status: 503; error: 'member_registration_unavailable' | 'member_registration_misconfigured' } | null {
  if (
    err instanceof MemberRegistrationUnavailableError ||
    err instanceof MemberRegistrationMisconfiguredError
  ) {
    return { status: 503, error: err.code }
  }
  return null
}
