import { config } from '../config.js'
import {
  type RateLimitCheck,
  type RateLimitCheckOptions,
  createRateLimitCheck,
} from './rateLimitMiddleware.js'

/** Writes to the watch set are cheap and bursty (one per navigation), opens are not. */
export const GFS_WATCH_PUT_RL_PER_MIN = 120
export const GFS_WATCH_PUT_BUCKET_TYPE = 'external_gfs_watch_put'

/**
 * Per-user budget for opening a long-lived external stream. Without a
 * Postgres count the request is refused (`'closed'`): a stream holds a
 * connection for minutes, so admitting it uncounted is the expensive mistake.
 * Read at call time so a route set built after a config change picks it up.
 */
export function externalUserStreamOpenRateLimitOptions(): RateLimitCheckOptions {
  return {
    bucketType: 'external_user',
    maxPerMinute: config.approvalRlExternalPerMin,
    onBackendUnavailable: 'closed',
  }
}

export function gfsWatchOpenBucketKey(userId: string): string {
  return `user:${userId}:gfs-watch-open`
}

export function gfsWatchPutBucketKey(userId: string): string {
  return `user:${userId}:gfs-watch-put`
}

/** Create once per route set: the check owns its throttled warn line. */
export function createGfsWatchOpenRateLimitCheck(): RateLimitCheck {
  return createRateLimitCheck(externalUserStreamOpenRateLimitOptions())
}

/** Create once per route set: the check owns its throttled warn line. */
export function createGfsWatchPutRateLimitCheck(): RateLimitCheck {
  return createRateLimitCheck({
    // Its own label: PUT denials would otherwise be indistinguishable in
    // rate_limit_hits_total from the stream opens that share 'external_user'.
    bucketType: GFS_WATCH_PUT_BUCKET_TYPE,
    maxPerMinute: GFS_WATCH_PUT_RL_PER_MIN,
    onBackendUnavailable: 'closed',
  })
}
