/**
 * The transport a GFS watch client falls back to when its creator passes none,
 * and a hook told of every client created. Nothing sets them in the app; a test
 * setup does, so that a service built only to test something else never opens a
 * real stream with its session token nor leaves reconnect timers behind.
 *
 * Kept on `globalThis` and free of imports: a test that resets its module
 * registry and imports the app service again still gets the same defaults, and
 * the setup can install them without loading the main-process modules.
 */
export type GfsWatchTransportDefaults = {
  fetch?: typeof fetch
  onClientCreated?: (client: { dispose(): void }) => void
}

const KEY = Symbol.for('evenfire.gfsWatch.transportDefaults')

type Holder = { [KEY]?: GfsWatchTransportDefaults }

export function setGfsWatchTransportDefaults(defaults: GfsWatchTransportDefaults | null): void {
  ;(globalThis as Holder)[KEY] = defaults ?? undefined
}

export function gfsWatchTransportDefaults(): GfsWatchTransportDefaults {
  return (globalThis as Holder)[KEY] ?? {}
}
