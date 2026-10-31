// E2E_GUARDIAN_IPC_FLOW: the OS save dialog is an external boundary, replaced here.
import type { ElectronApplication } from '@playwright/test'

/**
 * Replace the OS save dialog with one that answers `filePath`.
 *
 * This is the only stub a Recent-files journey may use: it replaces an external
 * boundary (the native dialog), never a product path. `zipStream.ts` reads
 * `dialog.showSaveDialog` at call time, so replacing it after launch is enough,
 * and the archive is really written to `filePath` by the product code.
 *
 * The replacement is installed inside the Electron main process, where the
 * product's own `dialog` import resolves.
 */
export async function stubSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(async ({ dialog }, target) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as never
  }, filePath)
}
