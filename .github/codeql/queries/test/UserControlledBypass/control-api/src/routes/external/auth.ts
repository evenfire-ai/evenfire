import express from 'express'
import { sendPublicApiError } from '../../http/publicApiError'

declare function authenticatePasswordAndIssueSession(email: string, password: string): void
declare function authenticateExternalUserSession(token: string): void
declare function issueSession(): string
declare function readProtectedData(): string
declare function setAuthenticated(): void
declare function mayReturnSuccess(
  req: express.Request,
  res: express.Response,
  status: number,
): void

const router = express.Router()

router.post('/safe-password', (req, res) => {
  const email = String(req.body?.email || '').trim()
  const password = String(req.body?.password || '')
  if (!email || !password) return res.status(400).json({ error: 'invalid_credentials' })
  authenticatePasswordAndIssueSession(email, password)
  return res.sendStatus(204)
})

router.post('/safe-session', (req, res) => {
  const token = String(req.body?.token || '').trim()
  if (!token || token.length > 4096) {
    sendPublicApiError(req, res, 401, 'invalid_session', 'Invalid session.')
    return
  }
  authenticateExternalUserSession(token)
  return res.sendStatus(204)
})

router.post('/safe-block-response', (req, res) => {
  const token = String(req.body?.token || '')
  if (!token) {
    res.status(401).json({ error: 'invalid_session' })
    return
  }
  authenticateExternalUserSession(token)
  return res.sendStatus(204)
})

// Mirrors the production handler shape: stock early-abort recognition loses
// this path through the surrounding try/catch, so the repository model must
// prove the fixed failure response itself.
router.post('/safe-braced-password-in-try', (req, res) => {
  try {
    const email = String(req.body?.email || '').trim()
    const password = String(req.body?.password || '')
    if (!email || !password) {
      return res.status(400).json({ error: 'invalid_credentials' })
    }
    authenticatePasswordAndIssueSession(email, password)
    return res.sendStatus(204)
  } catch {
    return res.status(503).json({ error: 'unavailable' })
  }
})

router.post('/safe-helper-token-in-try', (req, res) => {
  try {
    const token = String(req.body?.token || '').trim()
    if (!token || token.length > 4096) {
      sendPublicApiError(req, res, 401, 'invalid_session', 'Invalid session.')
      return
    }
    authenticateExternalUserSession(token)
    return res.sendStatus(204)
  } catch {
    return res.status(503).json({ error: 'unavailable' })
  }
})

router.post('/bypass-protected-data', (req, res) => {
  const token = String(req.body?.token || '')
  if (!token) return res.status(200).json({ data: readProtectedData() })
  authenticateExternalUserSession(token)
  return res.sendStatus(204)
})

router.post('/bypass-session-issuance', (req, res) => {
  const password = String(req.body?.password || '')
  if (!password) return res.status(200).json({ token: issueSession() })
  authenticatePasswordAndIssueSession('user@example.test', password)
  return res.sendStatus(204)
})

router.post('/single-branch-auth', (req, res) => {
  const token = String(req.body?.token || '')
  if (token) {
    authenticateExternalUserSession(token)
  } else {
    return res.status(200).json({ data: readProtectedData() })
  }
  return res.sendStatus(204)
})

router.post('/sets-authenticated', (req, res) => {
  const token = String(req.body?.token || '')
  if (!token) {
    setAuthenticated()
    return res.status(401).json({ error: 'invalid_session' })
  }
  authenticateExternalUserSession(token)
  return res.sendStatus(204)
})

router.post('/alternate-issuance', (req, res) => {
  const token = String(req.body?.token || '')
  if (!token) {
    return res.status(200).json({ token: issueSession() })
  }
  authenticateExternalUserSession(token)
  return res.sendStatus(204)
})

router.post('/unrelated-400', (req, res) => {
  const token = String(req.body?.token || '')
  res.status(400).json({ error: 'unrelated' })
  if (!token) readProtectedData()
  authenticateExternalUserSession(token)
  return res.sendStatus(204)
})

router.post('/unrelated-400-does-not-sanitize', (req, res) => {
  const token = String(req.body?.token || '')
  res.status(400).json({ error: 'unrelated' })
  if (!token) return res.status(200).json({ data: readProtectedData() })
  authenticateExternalUserSession(token)
  return res.sendStatus(204)
})

router.post('/post-work-4xx', (req, res) => {
  const token = String(req.body?.token || '')
  if (!token) {
    readProtectedData()
    return res.status(401).json({ error: 'invalid_session' })
  }
  authenticateExternalUserSession(token)
  return res.sendStatus(204)
})

router.post('/failure-response-leaks-data', (req, res) => {
  const token = String(req.body?.token || '')
  if (!token) return res.status(401).json({ data: readProtectedData() })
  authenticateExternalUserSession(token)
  return res.sendStatus(204)
})

router.post('/unproven-helper', (req, res) => {
  const token = String(req.body?.token || '')
  if (!token) {
    mayReturnSuccess(req, res, 401)
    return
  }
  authenticateExternalUserSession(token)
  return res.sendStatus(204)
})

export default router
