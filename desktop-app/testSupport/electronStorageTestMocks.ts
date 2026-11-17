const ciphertexts = new Map<string, string>()
let nextCiphertext = 0

/** Hermetic Electron safeStorage fallback for main-process integration tests. */
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(plaintext: string): Buffer {
    const ciphertext = `vitest-safe-storage-${++nextCiphertext}`
    ciphertexts.set(ciphertext, plaintext)
    return Buffer.from(ciphertext, 'utf8')
  },
  decryptString(ciphertext: Buffer): string {
    const plaintext = ciphertexts.get(ciphertext.toString('utf8'))
    if (plaintext === undefined) throw new Error('unknown test safeStorage ciphertext')
    return plaintext
  },
}
