/**
 * Keeps plugin storage contract tests independent of Windows native ACL startup.
 *
 * The native DACL and file-operation contracts are exercised by
 * pluginStorageWindowsAcl.native.test.ts. Store, gate, and broker unit tests
 * still use real temporary files; this fixture replaces only that OS boundary.
 */
export class PluginStoragePrivacyUnitFixture {
  async ensureDirectory(): Promise<void> {}

  async verifyDirectory(): Promise<void> {}

  async verifyFile(): Promise<undefined> {
    return undefined
  }

  async recordRename(): Promise<void> {}

  forget(): void {}
}
