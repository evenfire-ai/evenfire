export type A01FocusTarget = 'body' | 'opener' | 'toggle' | 'chat' | 'files' | 'sibling'
export type A01Binding =
  | 'same'
  | 'metadata-only'
  | 'different-id'
  | 'different-uri'
  | 'different-kind'
  | 'different-parent'
  | 'missing'

export type A01A4Input = {
  clickedUri: string
  requestCurrent: boolean
  permissionGranted: boolean
  binding: A01Binding
  d2Observed: boolean
  sessionCurrent: boolean
  navigationCurrent: boolean
  ownerCurrent: boolean
  newerFocus: Exclude<A01FocusTarget, 'body' | 'opener' | 'toggle'> | null
  newerFocusConnected: boolean
  openerConnected: boolean
  toggleConnected: boolean
  surface: 'chat' | 'files'
}

export type A01A4Outcome = {
  writes: string[]
  staleError: boolean
  exactParentInvalidations: number
  focus: A01FocusTarget
  surface: 'chat' | 'files'
  modalCount: 0
  quiescent: true
}

/** Independent observable contract oracle for the A01 A4 predicates. */
export function evaluateA01A4(input: A01A4Input): A01A4Outcome {
  const ownerCurrent =
    input.requestCurrent && input.sessionCurrent && input.navigationCurrent && input.ownerCurrent
  const identityCurrent = input.binding === 'same' || input.binding === 'metadata-only'
  const staleError = input.d2Observed
  const writes =
    ownerCurrent && input.permissionGranted && identityCurrent && !input.d2Observed
      ? [input.clickedUri]
      : []

  let focus: A01FocusTarget
  if (input.newerFocus && input.newerFocusConnected) {
    focus = input.newerFocus
  } else if (input.newerFocus) {
    // The token was canceled by newer user intent before its target unmounted.
    focus = 'body'
  } else if (!ownerCurrent) {
    focus = 'body'
  } else if (staleError || !input.openerConnected) {
    focus = input.toggleConnected ? 'toggle' : 'body'
  } else {
    focus = 'opener'
  }

  return {
    writes,
    staleError,
    exactParentInvalidations: input.d2Observed ? 1 : 0,
    focus,
    surface: input.surface,
    modalCount: 0,
    quiescent: true,
  }
}
