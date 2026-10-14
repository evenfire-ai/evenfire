import express from 'express'

const internalServiceToken = 'Synthetic-R6-Producer-Contract-Token'

export function responseDropProxyApp(
  producerBaseUrl: string,
  onDroppedReset: () => void,
  options: {
    dropResetResponse?: boolean
    resetFault?:
      | 'html'
      | 'missing_session'
      | 'empty_session'
      | 'invalid_payload'
      | 'legacy_busy'
      | 'legacy_unavailable'
  } = {}
) {
  const producerBase = new URL(producerBaseUrl)
  const expectedProducerBaseUrl = `http://127.0.0.1:${producerBase.port}/api/v1`
  if (
    producerBase.protocol !== 'http:' ||
    producerBase.hostname !== '127.0.0.1' ||
    !producerBase.port ||
    producerBase.username ||
    producerBase.password ||
    producerBase.pathname !== '/api/v1' ||
    producerBase.search ||
    producerBase.hash ||
    producerBaseUrl !== expectedProducerBaseUrl
  ) {
    throw new Error('response-drop proxy requires the task-owned loopback Control API producer')
  }

  const previewRequestPath = '/api/v1/external/invitations/token/r6-synthetic-reset-proof'
  const resetRequestPath = '/api/v1/external/invitations/password-token'
  const previewProducerUrl = new URL(previewRequestPath, producerBase.origin)
  const resetProducerUrl = new URL(resetRequestPath, producerBase.origin)
  const dropResetResponse = options.dropResetResponse ?? true
  const app = express()
  app.use(express.json())
  const forwardProducerResponse = async (
    req: express.Request,
    res: express.Response,
    method: 'GET' | 'POST',
    producerUrl: URL,
    dropResponse: boolean
  ) => {
    const requestPath = method === 'GET' ? previewRequestPath : resetRequestPath
    if (req.originalUrl !== requestPath) {
      res.sendStatus(404)
      return
    }
    if (
      req.headers.authorization !== `Bearer ${internalServiceToken}` ||
      req.headers['x-service-token'] !== 'external-rest-api'
    ) {
      res.sendStatus(404)
      return
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${internalServiceToken}`,
      'x-service-token': 'external-rest-api',
      'content-type': 'application/json',
    }
    const clientIp = req.headers['x-external-client-ip']
    if (typeof clientIp === 'string') headers['x-external-client-ip'] = clientIp
    const upstream = await fetch(producerUrl, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(req.body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
    const body = await upstream.text()
    if (method === 'POST' && options.resetFault) {
      onDroppedReset()
      if (options.resetFault === 'html') {
        res.status(502).type('text/html').send('<html>synthetic gateway failure</html>')
      } else if (
        options.resetFault === 'legacy_busy' ||
        options.resetFault === 'legacy_unavailable'
      ) {
        const busy = options.resetFault === 'legacy_busy'
        res.setHeader('retry-after', busy ? '9' : '1200')
        res.setHeader('x-ratelimit-remaining', '0')
        res.status(busy ? 429 : 503).json({
          error: busy ? 'verification_busy' : 'authority_failure',
          diagnostic: 'private Control API detail',
        })
      } else if (options.resetFault === 'invalid_payload') {
        res.status(400).json({ error: 'invalid payload' })
      } else {
        const payload = JSON.parse(body)
        if (options.resetFault === 'missing_session') delete payload.token
        else payload.token = ''
        res.status(upstream.status).json(payload)
      }
      return
    }
    if (dropResponse) {
      onDroppedReset()
      req.socket.destroy()
      return
    }
    res.status(upstream.status).type('application/json').send(body)
  }
  app.get(previewRequestPath, async (req, res) => {
    if (req.method !== 'GET') {
      res.sendStatus(404)
      return
    }
    await forwardProducerResponse(req, res, 'GET', previewProducerUrl, false)
  })
  app.post(resetRequestPath, async (req, res) =>
    forwardProducerResponse(req, res, 'POST', resetProducerUrl, dropResetResponse)
  )
  app.use((_req, res) => res.sendStatus(404))
  return app
}
