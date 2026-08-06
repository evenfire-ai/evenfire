import type { EnvSecret } from '../../lib/api'
import type { CredentialSurface } from './resolveCredentialSurface'

export type UpdateConnectorCredentialsProps = {
  /**
   * McpServer CRD name — the connector currently being edited. Also the
   * resource polled via getMcpServer() once a rotation is submitted: success
   * is derived exclusively from THIS connector's own DeploymentReady
   * condition, never from the PUT's 200 alone (issue #223 plan, Fase 3 §4).
   */
  serverName: string
  /**
   * server.spec.envSecret, or undefined when the connector has no
   * Kubernetes-Secret-backed credentials. The panel renders explanatory copy
   * instead of a form when this is unset.
   */
  envSecret: EnvSecret | undefined
  /**
   * Which credential surface to render, derived by resolveCredentialSurface()
   * from the McpServer's SecretResolved condition and spec.managed. Optional
   * and defaulting to 'rotate' so existing call sites keep today's behavior.
   */
  surface?: CredentialSurface
}

/**
 * The phases are shared by BOTH write directions, so "the write" below means
 * the PUT to /admin/mcp-secrets/:name in rotate mode and the POST to
 * /admin/mcp-secrets in set mode (including its merge-patch retry). Which one
 * a given phase refers to is recorded separately, in `submittedMode`.
 *
 * - idle:     form is editable, nothing in flight.
 * - saving:   the write is in flight.
 * - rotating: the write returned 2xx; polling getMcpServer() for a fresh
 *             DeploymentReady condition (the connector restarting after a
 *             rotation, or starting for the first time after a create).
 * - success:  a fresh DeploymentReady=True was observed after the write.
 * - failed:   the write itself failed, OR a fresh DeploymentReady=False was
 *             observed after it.
 * - timeout:  the bounded poll window elapsed without a fresh terminal
 *             condition. Never reported as success.
 */
export type RotationPhase = 'idle' | 'saving' | 'rotating' | 'success' | 'failed' | 'timeout'
