export const PASSWORD_CREDENTIAL_CHANGED_PUBLIC_RESPONSE = Object.freeze({
  status: 409,
  body: Object.freeze({
    error:
      'Your password changed during this request. Sign in again with your new password.' as const,
  }),
})
