/** clerum__generate_xlsx: builds the workbook (xlsxWorkbook, loaded on first use) and writes it. */
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

/** Largest box an image placed in a sheet is fitted into, in pixels. */
const XLSX_MAX_IMAGE_WIDTH = 640
const XLSX_MAX_IMAGE_HEIGHT = 400

export async function runGenerateXlsx(
  args: Record<string, unknown>,
  outputDir: string
): Promise<InternalToolResult> {
  try {
    const filename = outputFilename(args.filename, 'xlsx', 'output')
    const warnings: string[] = []
    const aliased: string[] = []
    const { buildXlsxWorkbook } = await import('./xlsxWorkbook')
    const built = await buildXlsxWorkbook(
      args,
      outputDir,
      { width: XLSX_MAX_IMAGE_WIDTH, height: XLSX_MAX_IMAGE_HEIGHT },
      warnings,
      aliased
    )
    if (!built.ok) return { success: false, error: built.error }
    // The workbook is already in memory, so a quota breach leaves no partial file.
    ensureDir(outputDir)
    const target = claimOutputFile(outputDir, filename)
    enforceQuota(outputDir, built.buffer.byteLength, replacedBytes(target))
    writeArtifact(target, built.buffer)
    return {
      ...artifactResult(target, 'xlsx', {
        summary: `File generated: ${target.filename} (xlsx): ${built.summary}.`,
        warnings,
      }),
      aliasedArguments: aliased,
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
