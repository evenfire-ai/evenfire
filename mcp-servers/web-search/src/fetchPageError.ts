export type FetchPageErrorCode =
  | 'invalid_url'
  | 'destination_blocked'
  | 'redirect_limit'
  | 'deadline_exceeded'
  | 'response_too_large'
  | 'unsupported_encoding'
  | 'upstream_failure'
  | 'busy'
  | 'cancelled'

/** Public errors contain no upstream URL, address, response body or native error. */
export class FetchPageError extends Error {
  constructor(readonly code: FetchPageErrorCode) {
    super(code)
    this.name = 'FetchPageError'
  }
}
