/** How every internal tool runs: lazy generator modules and the argument preparation around them. */
import { unknownArguments, withoutUnsetNulls } from './schemaArguments'
import { cleanToolArgs } from './toolText'
import type { InternalToolDefinition, InternalToolResult } from './types'

/**
 * Runs a generator from its own module, loaded on first use so that starting
 * the host loads no document library. A module that fails to load fails the
 * call the way a generator error does.
 */
export async function fromModule<M>(
  load: () => Promise<M>,
  run: (loaded: M) => Promise<InternalToolResult>
): Promise<InternalToolResult> {
  let loaded: M
  try {
    loaded = await load()
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
  return run(loaded)
}

/**
 * A generator that runs on cleaned arguments (cleanToolArgs, unset nulls
 * dropped, named images decoded) and reports the arguments it does not take:
 * those its schema does not declare, less the ones the generator says it took
 * under another name (aliasedArguments).
 */
export function prepared(tool: InternalToolDefinition): InternalToolDefinition {
  return {
    ...tool,
    execute: async (args, outputDir) => {
      let clean: Record<string, unknown>
      let release: () => void
      try {
        clean = withoutUnsetNulls(tool.parameters, cleanToolArgs(args ?? {})) as Record<
          string,
          unknown
        >
        const { predecodeImages } = await import('./embeddedImages')
        release = await predecodeImages(clean, outputDir)
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
      // Named from the arguments as sent, before the generator runs, so nothing
      // it does with them (a copy, a spread) changes what is reported.
      const undeclared = unknownArguments(tool.parameters, clean)
      let outcome: InternalToolResult
      try {
        outcome = await tool.execute(clean, outputDir)
      } finally {
        release()
      }
      const { aliasedArguments, ...result } = outcome
      const taken = new Set(aliasedArguments ?? [])
      const ignored = undeclared.filter(entry => !taken.has(entry))
      if (!result.success || ignored.length === 0) return result
      const listed = ignored.slice(0, 10).map(name => `'${name}'`)
      if (ignored.length > 10) listed.push(`and ${ignored.length - 10} more`)
      const note = `Ignored arguments this tool does not read: ${listed.join(', ')}.`
      const content = result.content ?? ''
      return {
        ...result,
        content: /\nNotes: /.test(content) ? `${content} ${note}` : `${content}\nNotes: ${note}`,
      }
    },
  }
}

/**
 * A tool that reads a null sent for an optional argument as unset, as the
 * generators do, so a call means the same from chat and from a workflow step.
 */
export function nullsUnset(tool: InternalToolDefinition): InternalToolDefinition {
  return {
    ...tool,
    execute: (args, outputDir, options) =>
      tool.execute(
        withoutUnsetNulls(tool.parameters, args ?? {}) as Record<string, unknown>,
        outputDir,
        options
      ),
  }
}
