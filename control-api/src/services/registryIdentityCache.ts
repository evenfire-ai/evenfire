let registryIdentityCacheGeneration = 0

export function invalidateRegistryIdentityCaches(): void {
  registryIdentityCacheGeneration += 1
}

export function getRegistryIdentityCacheGeneration(): number {
  return registryIdentityCacheGeneration
}

export function __resetRegistryIdentityCacheGenerationForTests(): void {
  registryIdentityCacheGeneration = 0
}
