/**
 * Generation counter for Host watch events. A completion is latest only when
 * no newer event has called begin() since this one started.
 */
export function createHostEventGate(): {
  begin(): number
  isLatest(generation: number): boolean
} {
  let latest = 0
  return {
    begin() {
      latest += 1
      return latest
    },
    isLatest(generation: number) {
      return generation === latest
    },
  }
}
