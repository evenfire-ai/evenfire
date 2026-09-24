import { randomBytes } from 'node:crypto'

const origin = 'https://auth.openai.com'
const device = '/api/accounts/deviceauth/'
const paths = new Set([`${device}usercode`, `${device}token`, '/oauth/token'])
const opaque = () => randomBytes(24).toString('hex')
const reply = (body, status = 200) => Response.json(body, { status })
const invalid = () => reply({ error: 'invalid_grant' }, 400)

export function validateFixtureEnvironment(env) {
  if (
    env.NODE_ENV !== 'test' ||
    env.EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE !== '1' ||
    !/^approved-tools-[a-f0-9]{12}$/.test(env.APPROVED_TOOLS_RUN_ID ?? '') ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(env.MINIKUBE_PROFILE ?? '') ||
    env.MINIKUBE_PROFILE !== env.CONTROL_API_REAL_PG_CONTEXT ||
    !env.KUBERNETES_SERVICE_HOST
  )
    throw new Error('OAuth fixture requires its isolated test environment')
}

// Only the external device OAuth boundary is synthetic. All application routes,
// permissions, persistence and subscription selection remain real.
export function createOAuthFixtureFetch(delegate, { now = Date.now } = {}) {
  const sessions = new Map()
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.origin !== origin) return delegate(input, init)
    // Unsupported OAuth operations must never send fixture credentials to the
    // real provider (including revoke or refresh paths outside this journey).
    if (!paths.has(url.pathname)) return invalid()
    // The production caller uses URL + init with a string body. Reject other
    // forms instead of reading an unbounded stream or reaching the real provider.
    if (
      input instanceof Request ||
      init.method !== 'POST' ||
      url.search ||
      url.hash ||
      typeof init.body !== 'string' ||
      Buffer.byteLength(init.body) > 16384
    )
      return invalid()
    for (const [id, session] of sessions) if (session.expires <= now()) sessions.delete(id)
    let body
    try {
      body =
        url.pathname === '/oauth/token'
          ? Object.fromEntries(new URLSearchParams(init.body))
          : JSON.parse(init.body)
    } catch {
      return invalid()
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid()
    if (url.pathname === `${device}usercode`) {
      if (typeof body.client_id !== 'string' || !body.client_id || sessions.size >= 32)
        return invalid()
      const id = opaque()
      const session = {
        client: body.client_id,
        user: opaque(),
        code: opaque(),
        verifier: opaque(),
        expires: now() + 300000,
        polled: false,
        issued: false,
      }
      sessions.set(id, session)
      return reply({ device_auth_id: id, user_code: session.user, interval: 1, expires_in: 300 })
    }
    if (url.pathname === `${device}token`) {
      const session = sessions.get(body.device_auth_id)
      if (!session || session.user !== body.user_code) return invalid()
      if (!session.polled) {
        session.polled = true
        return reply({ error: 'authorization_pending' }, 403)
      }
      session.issued = true
      return reply({ authorization_code: session.code, code_verifier: session.verifier })
    }
    const entry = [...sessions].find(([, session]) => session.code === body.code)
    if (!entry) return invalid()
    const [id, session] = entry
    if (
      !session.issued ||
      body.grant_type !== 'authorization_code' ||
      body.client_id !== session.client ||
      body.code_verifier !== session.verifier ||
      body.redirect_uri !== `${origin}/deviceauth/callback`
    )
      return invalid()
    sessions.delete(id)
    const subject = `fixture-${opaque()}`
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
    // Deliberately not an OpenAI credential; only this isolated external fixture
    // produces it, and the deterministic proxy supplies the model boundary.
    const idToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: subject,
      exp: Math.floor(now() / 1000) + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: subject },
    })}.fixture`
    return reply({
      access_token: `fixture-${opaque()}`,
      refresh_token: `fixture-${opaque()}`,
      expires_in: 3600,
      id_token: idToken,
    })
  }
}
