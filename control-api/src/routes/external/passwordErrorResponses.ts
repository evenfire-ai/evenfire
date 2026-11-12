export const PASSWORD_NOT_SET_RESPONSE = Object.freeze({
  status: 409,
  body: Object.freeze({ error: 'password_not_set' as const }),
})

export const PASSWORD_CREDENTIAL_CHANGED_RESPONSE = Object.freeze({
  status: 409,
  body: Object.freeze({ error: 'credential_changed' as const }),
})
