/**
 * A Host-access operation this rpc-proxy requires answered 404 from control-api.
 * The peer predates the route, so this is a producer/consumer version mismatch,
 * never an authorization decision about the user or the Host.
 *
 * It lives in its own module so every consumer imports one class identity
 * without depending on the HTTP client module, whose surface route tests
 * replace with a partial mock.
 */
export type ControlApiHostOperation =
  | 'host-access'
  | 'host-message-resolution'
  | 'host-artifact-read'

export class ControlApiHostVersionMismatchError extends Error {
  constructor(readonly operation: ControlApiHostOperation) {
    super(`Control API does not implement ${operation} (version mismatch, HTTP 404)`)
    this.name = 'ControlApiHostVersionMismatchError'
  }
}
