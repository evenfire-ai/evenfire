let registryIdentityCacheGeneration = 0

export class RegistryIdentityChangedError extends Error {
  constructor() {
    super('registry_identity_changed')
    this.name = 'RegistryIdentityChangedError'
  }
}

export function invalidateRegistryIdentityCaches(): void {
  registryIdentityCacheGeneration += 1
}

export function getRegistryIdentityCacheGeneration(): number {
  return registryIdentityCacheGeneration
}

export function isRegistryIdentityCacheGenerationCurrent(generation: number): boolean {
  return registryIdentityCacheGeneration === generation
}

export async function withCurrentRegistryIdentity<T>(
  read: (generation: number) => Promise<T>,
  opts: { staleError?: () => Error } = {}
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const generation = getRegistryIdentityCacheGeneration()
    try {
      const value = await read(generation)
      if (isRegistryIdentityCacheGenerationCurrent(generation)) return value
    } catch (err) {
      if (isRegistryIdentityCacheGenerationCurrent(generation)) throw err
    }
  }
  throw opts.staleError?.() ?? new RegistryIdentityChangedError()
}

export function __resetRegistryIdentityCacheGenerationForTests(): void {
  registryIdentityCacheGeneration = 0
}
