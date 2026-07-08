/**
 * JWT RS256 Token Factory for workflow authentication.
 *
 * Signs multiple token types using the `clerum-wrc-signing-key` private key:
 * 1. WRC → mcp_host (configure) — mounted in Secret, 1h TTL
 * 2. WRC → mcp_host (artifact read) — ephemeral, 60s TTL, signed fresh per request
 * 3. WRC → mcp_host (artifact delete) — ephemeral, 60s TTL, cleanup only
 * 4. Coordinator → mcp_host (execute) — mounted in Secret
 * 5. Coordinator → WRC (status/configure_model/model_injection_request) — mounted in Secret
 * 5b. Custom coordinator → WRC (reduced status/signal/health/model_injection_request) — mounted in Secret
 * 6. CronJob → WRC (trigger_write) — mounted in Secret
 * */
import { SignJWT, importPKCS8 } from 'jose'
import { randomUUID } from 'node:crypto'

export type TokenAudience = 'mcp-host' | 'clerum-wrc'
export type TokenSubject = 'coordinator' | 'custom-coordinator' | 'wrc' | 'cronjob'

export interface TokenClaims {
  sub: TokenSubject
  aud: TokenAudience
  recipeName: string
  /**
   * Kubernetes namespace where the WorkflowRecipe CRD lives. WRC knows the
   * namespace at signing time, and handlers use this claim instead of the WRC
   * pod namespace when reading or patching the CRD.
   */
  recipeNamespace: string
  runId?: string
  artifactName?: string
  scopes: string[]
}

/** Default TTL for rotatable runtime JWTs mounted through Kubernetes Secret volumes. */
export const DEFAULT_RUNTIME_TOKEN_TTL_SECONDS = 15 * 60
/** Cron trigger tokens are separate from live runtime JWTs and are refreshed by WRC. */
const CRONJOB_TRIGGER_TOKEN_EXPIRY_SECONDS = 60 * 60
/** Ephemeral artifact tokens (60s) — signed fresh per request, never stored. */
const ARTIFACT_TOKEN_EXPIRY_SECONDS = 60

export class JwtTokenFactory {
  private privateKey: Awaited<ReturnType<typeof importPKCS8>> | null = null

  constructor(
    private readonly privateKeyPem: string,
    private readonly options: { runtimeTokenTtlSeconds?: number } = {}
  ) {}

  private get runtimeTokenTtlSeconds(): number {
    return this.options.runtimeTokenTtlSeconds ?? DEFAULT_RUNTIME_TOKEN_TTL_SECONDS
  }

  async initialize(): Promise<void> {
    this.privateKey = await importPKCS8(this.privateKeyPem, 'RS256')
  }

  /**
   * Token Type 1a: WRC → mcp_host — persistent configure token (1h TTL).
   * Mounted in the coordinator's Secret for model hot-swap calls.
   * Scopes: configure, health:read, kill_switch:write. NO artifact scopes.
   */
  async signWrcConfigureToken(recipeName: string, recipeNamespace: string): Promise<string> {
    return this.sign(
      {
        sub: 'wrc',
        aud: 'mcp-host',
        recipeName,
        recipeNamespace,
        scopes: ['configure', 'health:read', 'kill_switch:write'],
      },
      this.runtimeTokenTtlSeconds
    )
  }

  /**
   * Token Type 1b: WRC → mcp_host — ephemeral artifact read token (60s TTL).
   * Signed fresh for each artifact download — never stored. Least privilege:
   * only `artifact_read` scope, so a leaked token cannot configure or kill pods.
   */
  async signWrcArtifactToken(
    recipeName: string,
    recipeNamespace: string,
    options: { runId?: string; artifactName?: string } = {}
  ): Promise<string> {
    return this.sign(
      {
        sub: 'wrc',
        aud: 'mcp-host',
        recipeName,
        recipeNamespace,
        ...options,
        scopes: ['artifact_read'],
      },
      ARTIFACT_TOKEN_EXPIRY_SECONDS
    )
  }

  /**
   * Token Type 1c: WRC → mcp_host — ephemeral artifact delete token (60s TTL).
   * Used ONLY by reconcileDelete() to clean up a recipe's /output subdirectory
   * via HTTP DELETE before tearing down the pod. Scope `artifact_delete` is
   * non-overlapping with `artifact_read`: a coordinator cannot trigger cleanup.
   */
  async signWrcArtifactDeleteToken(
    recipeName: string,
    recipeNamespace: string,
    options: { runId?: string; artifactName?: string } = {}
  ): Promise<string> {
    return this.sign(
      {
        sub: 'wrc',
        aud: 'mcp-host',
        recipeName,
        recipeNamespace,
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.artifactName ? { artifactName: options.artifactName } : {}),
        scopes: ['artifact_delete'],
      },
      ARTIFACT_TOKEN_EXPIRY_SECONDS
    )
  }

  /** Token Type 2: Coordinator → mcp_host (scopes: execute, mode_read, status_read, health:read) */
  async signCoordinatorToMcpHostToken(
    recipeName: string,
    recipeNamespace: string
  ): Promise<string> {
    return this.sign(
      {
        sub: 'coordinator',
        aud: 'mcp-host',
        recipeName,
        recipeNamespace,
        scopes: ['execute', 'mode_read', 'status_read', 'health:read'],
      },
      this.runtimeTokenTtlSeconds
    )
  }

  /** Token Type 3: Coordinator → WRC (scopes: configure_model, model_injection_request, status_write, status_read, signal_read, health_read, trigger_write) */
  async signCoordinatorToWrcToken(recipeName: string, recipeNamespace: string): Promise<string> {
    return this.sign(
      {
        sub: 'coordinator',
        aud: 'clerum-wrc',
        recipeName,
        recipeNamespace,
        scopes: [
          'configure_model',
          'model_injection_request',
          'status_write',
          'status_read',
          'signal_read',
          'health_read',
          'trigger_write',
        ],
      },
      this.runtimeTokenTtlSeconds
    )
  }

  /** Token Type 3b: Custom coordinator → WRC (no trigger_write or configure_model). */
  async signCustomCoordinatorToWrcToken(
    recipeName: string,
    recipeNamespace: string
  ): Promise<string> {
    return this.sign(
      {
        sub: 'custom-coordinator',
        aud: 'clerum-wrc',
        recipeName,
        recipeNamespace,
        scopes: [
          'model_injection_request',
          'status_write',
          'status_read',
          'signal_read',
          'health_read',
        ],
      },
      this.runtimeTokenTtlSeconds
    )
  }

  /** Token Type 4: CronJob → WRC (scope: trigger_write only — least privilege for scheduled triggers) */
  async signCronJobTriggerToken(recipeName: string, recipeNamespace: string): Promise<string> {
    return this.sign(
      {
        sub: 'cronjob',
        aud: 'clerum-wrc',
        recipeName,
        recipeNamespace,
        scopes: ['trigger_write'],
      },
      CRONJOB_TRIGGER_TOKEN_EXPIRY_SECONDS
    )
  }

  private async sign(claims: TokenClaims, ttlSeconds: number): Promise<string> {
    if (!this.privateKey) {
      throw new Error('JwtTokenFactory not initialized — call initialize() first')
    }
    if (!claims.recipeName) {
      throw new Error('JwtTokenFactory recipeName is required')
    }
    if (!claims.recipeNamespace) {
      throw new Error('JwtTokenFactory recipeNamespace is required')
    }

    return new SignJWT({
      recipeName: claims.recipeName,
      recipeNamespace: claims.recipeNamespace,
      ...(claims.runId ? { runId: claims.runId } : {}),
      ...(claims.artifactName ? { artifactName: claims.artifactName } : {}),
      scopes: claims.scopes,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject(claims.sub)
      .setAudience(claims.aud)
      .setIssuedAt()
      .setIssuer('clerum-wrc')
      .setJti(randomUUID())
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.privateKey)
  }
}
