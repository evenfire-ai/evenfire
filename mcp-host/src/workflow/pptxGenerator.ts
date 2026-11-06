/** clerum__generate_pptx: builds the deck (pptxDeck, loaded on first use) and writes it. */
import {
  artifactResult,
  claimOutputFile,
  enforceQuota,
  ensureDir,
  outputFilename,
  replacedBytes,
  writeArtifact,
} from './artifactOutput'
import type { InternalToolResult } from './types'

export async function runGeneratePptx(
  args: Record<string, unknown>,
  outputDir: string
): Promise<InternalToolResult> {
  try {
    const filename = outputFilename(args.filename, 'pptx', 'deck')
    const warnings: string[] = []
    const aliased: string[] = []
    const { buildPptxDeck } = await import('./pptxDeck')
    const { buffer, slides } = await buildPptxDeck(args, outputDir, warnings, aliased)
    // Buffer first, quota check, then an atomic write.
    ensureDir(outputDir)
    const target = claimOutputFile(outputDir, filename)
    enforceQuota(outputDir, buffer.byteLength, replacedBytes(target))
    writeArtifact(target, buffer)
    return {
      ...artifactResult(target, 'pptx', {
        summary: `File generated: ${target.filename} (pptx), ${slides} slide${slides === 1 ? '' : 's'}.`,
        warnings,
      }),
      aliasedArguments: aliased,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
