/**
 * NativeToolPresentationController — native-tool presentation (#1003).
 *
 * Decides which NATIVE tools appear in `tools[]`, independently of how MCP tools
 * are presented. MCP presentation (Codex/Grok `CODEX_TOOL_PRESENTATION`, legacy
 * `CLERUM_DYNAMIC_TOOLS_ENABLED` latch) stays in `DeferrableToolController`; this
 * decorator wraps OUTSIDE it, so it only ever removes natives from the list the
 * MCP decision already produced and never adds or removes an MCP tool.
 *
 * - `direct`: returns the upstream list unchanged (identity).
 * - `auto`: removes the natives selected by `selectDeferredNatives` over the
 *   native registry's own definitions (definition larger than the byte budget;
 *   bridge tools never selected), so a same-named MCP definition in the
 *   presented list cannot change the selection. Those natives
 *   stay callable through `clerum__tool_search` / `clerum__tool_describe` /
 *   `clerum__tool_call`. If any bridge tool is missing from the presented list,
 *   hiding a native would make it unreachable, so it throws instead.
 */
import { BRIDGE_TOOL_NAMES } from '../../capabilities/toolCatalogTools'
import { logger } from '../../logger'
import { LoopController } from '../interfaces'
import { ChatMessage, PendingApproval, ToolDefinition } from '../types'
import { type NativeToolPresentation, selectDeferredNatives } from './toolPresentationPolicy'

export class NativeToolPresentationController implements LoopController {
  private lastPresentation: string | undefined
  private readonly deferrable: ReadonlySet<string>

  constructor(
    private readonly delegate: LoopController,
    nativeDefinitions: ReadonlyArray<ToolDefinition>,
    private readonly config: { mode: NativeToolPresentation; discoveryBytes: number }
  ) {
    this.deferrable = selectDeferredNatives(nativeDefinitions, config.discoveryBytes)
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
    const upstream = await this.delegate.refreshTools(currentTools)
    if (this.config.mode === 'direct') return upstream

    const hidden = new Set(upstream.map(t => t.name).filter(name => this.deferrable.has(name)))
    if (hidden.size > 0) {
      const presentedNames = new Set(upstream.map(t => t.name))
      const missingBridge = [...BRIDGE_TOOL_NAMES].filter(name => !presentedNames.has(name))
      if (missingBridge.length > 0) {
        throw new Error(
          `Native tool discovery cannot hide ${[...hidden].join(', ')}: bridge tools ` +
            `${missingBridge.join(', ')} are not presented`
        )
      }
    }
    const presented = upstream.filter(t => !hidden.has(t.name))
    const measurement = {
      mode: this.config.mode,
      budget: this.config.discoveryBytes,
      hiddenNames: [...hidden].sort(),
      presentedCount: presented.length,
    }
    const key = JSON.stringify(measurement)
    if (key !== this.lastPresentation) {
      logger.info(
        { component: 'native-tool-presentation', ...measurement },
        'Native tool presentation selected'
      )
      this.lastPresentation = key
    }
    return presented
  }
}
