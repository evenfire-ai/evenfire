// Kept out of registry.ts so config.ts can default to these without importing
// the registry: the registry transitively imports config.ts, and the cycle
// would leave these bindings uninitialized while config.ts evaluates.
export const GFS_WATCH_MAX_CONNECTIONS = 256
export const GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL = 8
