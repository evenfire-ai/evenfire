/** Register a cancellation callback in the renderer and return its cleanup. */
export type GfsAbortRegistration = (onAbort: () => void) => () => void
