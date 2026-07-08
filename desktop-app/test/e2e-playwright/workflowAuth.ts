// Caller-auth helper for Desktop App E2E harnesses that hit
// `/api/v1/auth/mcp-host/:ns/:name/tokens`.
//
// The auth scheme is HS256 InternalControl JWT signed per request — the
// static `WRC_SERVICE_TOKEN` + `x-service-token: wrc` pair was removed by
// the InternalControl JWT migration.
import { signInternalControlJwt } from './internalControlJwt'

export function signWrcInternalControlJwt(k8sContext: string): string {
  return signInternalControlJwt('wrc', k8sContext)
}
