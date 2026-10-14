/** clerum__generate_pptx: builds the deck (pptxDeck, loaded on first use) and writes it. */
import * as fs from 'fs'
import {
  artifactResult,
  claimOutputFile,
  enforceQuota,
  ensureDir,
  outputFilename,
  replacedBytes,
} from './artifactOutput'
import type { InternalToolResult } from './types'

export async function runGeneratePptx(
  args: Record<string, unknown>,
  outputDir: string
): Promise<InternalToolResult> {
  try {
    const filename = outputFilename(args.filename, 'pptx', 'deck')
    const warnings: string[] = []
    const { buildPptxDeck } = await import('./pptxDeck')
    const { buffer, slides } = await buildPptxDeck(args, outputDir, warnings)
    // Buffer first, quota check, then write — atomic, no partial files.
    ensureDir(outputDir)
    const target = claimOutputFile(outputDir, filename)
    enforceQuota(outputDir, buffer.byteLength, replacedBytes(target))
    fs.writeFileSync(target.filePath, buffer)
    return artifactResult(target, 'pptx', {
      summary: `File generated: ${target.filename} (pptx), ${slides} slide${slides === 1 ? '' : 's'}.`,
      warnings,
    })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
