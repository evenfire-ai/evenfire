/**
 * Where the panel's authorize request stands. `unavailable` is the hub's 404: this account has
 * no Desktop setup by invitation. `failed` is every other failure.
 */
export type DesktopSetupState = 'idle' | 'pending' | 'opened' | 'unavailable' | 'failed'
