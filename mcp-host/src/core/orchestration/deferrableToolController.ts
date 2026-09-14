/**
 * DeferrableToolController — the OUTERMOST LoopController decorator for the
 * dynamic-tool-loading "stable bridge" design (Phase F3.1).
 *
 * When active, it removes all deferrable MCP tools from the advertised
 * `tools[]` array, leaving only the native tools (which include the 3 bridge
 * tools `clerum__tool_search` / `clerum__tool_describe` / `clerum__tool_call`).
 * Deferred MCP tools are reached exclusively through `clerum__tool_call`.
 *
 * Why a decorator (delegate-first composition): the inner chain
 * (`ApprovalController → UnifiedApprovalGateController` for interactive tasks,
 * or a bare `DefaultLoopController` for cron) keeps owning approval and text
 * gating. We only post-process the tool LIST returned by `refreshTools`.
 *
 * Other providers retain the legacy session latch. Codex evaluates its live
 * catalog on every refresh: a cold connection or provider switch must not keep
 * an obsolete threshold decision. Discovery never promotes schemas to tools[].
 *
 * `isNative` membership is decided by the exact `nativeNames` set (Critical:
 * `clerum__*` tools contain `__` but are native), NEVER by a string heuristic.
 */
import { logger } from '../../logger'
import { LoopController } from '../interfaces'
import { ChatMessage, PendingApproval, ToolDefinition } from '../types'
import type { CodexToolPresentation } from './toolPresentationPolicy'

/**
 * Session-scoped read/write of the latched `bridgeActive` decision. Bound to the
 * `Conversation` in production (`dynamicToolsBridgeActive`); tests pass a tiny
 * in-memory object. `get()` returns `undefined` until the first `set()`.
 */
export interface LatchStore {
  get(): boolean | undefined
  set(value: boolean): void
}

export class DeferrableToolController implements LoopController {
  private readonly delegate: LoopController
  private readonly nativeNames: Set<string>
  private readonly enabled: boolean
  private readonly threshold: number
  private readonly latch: LatchStore
  private readonly codexMode?: CodexToolPresentation
  private readonly discoveryBytes: number
  private lastPresentation: string | undefined

  constructor(
    delegate: LoopController,
    nativeNames: Set<string>,
    config: {
      dynamicToolsEnabled: boolean
      dynamicToolsThreshold: number
      codexMode?: CodexToolPresentation
      codexToolDiscoveryBytes?: number
    },
    latch: LatchStore
  ) {
    this.delegate = delegate
    this.nativeNames = nativeNames
    this.enabled = config.dynamicToolsEnabled
    this.threshold = config.dynamicToolsThreshold
    this.latch = latch
    this.codexMode = config.codexMode
    this.discoveryBytes = config.codexToolDiscoveryBytes ?? 32_768
  }

  shouldAccept(content: string, iteration: number): boolean {
    return this.delegate.shouldAccept(content, iteration)
  }

  onTextRejected(content: string, iteration: number): ChatMessage | null {
    return this.delegate.onTextRejected(content, iteration)
  }

  beforeTool(
    toolName: string,
    params: Record<string, unknown>
  ): 'proceed' | 'skip' | { type: 'suspend'; approval: PendingApproval } {
    return this.delegate.beforeTool(toolName, params)
  }

  onExhaustion(iteration: number): string {
    return this.delegate.onExhaustion(iteration)
  }

  async refreshTools(currentTools: ToolDefinition[]): Promise<ToolDefinition[]> {
    // Delegate first so we compose OVER approval's refresh (it currently passes
    // through, but never assume — the inner chain owns the upstream list).
    const upstream = await this.delegate.refreshTools(currentTools)

    // Codex must reevaluate the live catalog after late connections and provider
    // switches. Never reuse another provider's session latch or promote schemas.
    if (this.codexMode) {
      if (this.codexMode === 'direct') return upstream
      const deferred = upstream.filter(t => !this.nativeNames.has(t.name))
      const discover =
        this.codexMode === 'discovery' ||
        deferred.length > this.threshold ||
        Buffer.byteLength(JSON.stringify(deferred), 'utf8') > this.discoveryBytes
      const presented = discover ? upstream.filter(t => this.nativeNames.has(t.name)) : upstream
      const measurement = {
        mode: this.codexMode,
        strategy: discover ? 'discovery' : 'direct',
        nativeCount: upstream.length - deferred.length,
        mcpCount: deferred.length,
        presentedCount: presented.length,
        deferredCount: discover ? deferred.length : 0,
      }
      const key = JSON.stringify(measurement)
      if (key !== this.lastPresentation) {
        logger.info(
          { component: 'tool-presentation', ...measurement },
          'Tool presentation selected'
        )
        this.lastPresentation = key
      }
      return presented
    }

    // LATCH (LOCKED #6): compute the bridge decision exactly once per SESSION,
    // from the FIRST observed upstream tool set, and freeze it on the
    // session-scoped store. Later tasks read the same value.
    let bridgeActive = this.latch.get()
    if (bridgeActive === undefined) {
      const deferrableCount = upstream.filter(t => !this.nativeNames.has(t.name)).length
      bridgeActive = this.enabled && deferrableCount > this.threshold
      this.latch.set(bridgeActive)
      // Rollout observability: log ONCE per session, when the latch transitions
      // from unset to assigned — for BOTH outcomes (bridgeActive true or false),
      // NOT on every turn. Surfaces the cold-load decision (whether the bridge
      // engaged, the observed deferrable count, and the threshold) so we can see
      // recomputation visibility.
      logger.info(
        { component: 'deferrable-tools', bridgeActive, deferrableCount, threshold: this.threshold },
        'Legacy session presentation selected'
      )
    }

    // Passthrough — identical to today's behavior (flag off / under threshold).
    if (!bridgeActive) return upstream

    // STABLE SWAP: advertise ONLY natives (which include the 3 bridge tools).
    // Deterministic and session-invariant → `tools[]` byte-stable → cache-safe.
    return upstream.filter(t => this.nativeNames.has(t.name))
  }
}
