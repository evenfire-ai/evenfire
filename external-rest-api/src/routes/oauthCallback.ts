import { Router } from 'express'
import { controlApiPassthroughGet } from '../controlApiClient.js'

/**
 * PUBLIC OAuth callback. The provider (Google, …) redirects the user's browser
 * here after consent — there is no Clerum session or bearer token; authentication
 * IS the signed `state`, which control-api re-verifies. We forward the request to
 * control-api's stable callback endpoint verbatim — the raw query string is passed
 * untouched so the signed `state` and `code` are never re-encoded — and relay its
 * response, including the HTML success page that bounces to clerum://oauth-completed.
 *
 * This is the only public, unauthenticated route in this gateway, so it MUST stay a
 * thin passthrough: never read or trust anything beyond the path oauthClientId and
 * the opaque query string.
 */
export function createOauthCallbackRouter(): Router {
  const router = Router()

  router.get('/oauth-callback/:oauthClientId', async (req, res, next) => {
    try {
      const queryStart = req.originalUrl.indexOf('?')
      const rawQueryString = queryStart >= 0 ? req.originalUrl.slice(queryStart) : ''
      const result = await controlApiPassthroughGet(
        `/oauth-callback/${encodeURIComponent(String(req.params.oauthClientId))}`,
        rawQueryString
      )
      res.status(result.status).type(result.contentType).send(result.body)
    } catch (err) {
      next(err)
    }
  })

  return router
}
