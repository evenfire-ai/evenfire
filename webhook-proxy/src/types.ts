/**
 * Wire shape returned by control-api at
 * /api/v1/internal/webhook/registry/:recipeNs/:recipeName/:webhookId.
 * Keep in lockstep with control-api/src/routes/internal/webhooks.ts.
 */
export interface RegistryHit {
  exists: true
  methods: ReadonlyArray<'POST' | 'GET'>
  maxBodyBytes: number
  gateway: { service: string; namespace: string; port: number }
  // Origins (scheme + host [+ port]) authorized to invoke this webhook from a
  // browser. When set, the proxy answers CORS preflights and echoes a
  // matching origin on responses. When undefined or empty, browser preflights
  // get 403; the webhook is server-to-server only.
  allowedOrigins?: readonly string[]
}

export interface RegistryMiss {
  exists: false
  reason: 'recipe_not_found' | 'webhook_not_found'
}

/** Discriminant unifying success / negative-cache / transport error. */
export type RegistryResult =
  | RegistryHit
  | RegistryMiss
  | { exists: false; reason: 'invalid_request'; status: number }
  | { exists: false; reason: 'upstream_error'; detail: string }

/**
 * URL parameters extracted from `/api/v1/webhook/:recipeNs/:recipeName/:webhookId`.
 * The proxy revalidates each parameter against its regex BEFORE the
 * registry lookup; the gateway revalidates again on its side
 * (must-fix #2 of spec security analysis).
 */
export interface RouteIds {
  recipeNs: string
  recipeName: string
  webhookId: string
}
