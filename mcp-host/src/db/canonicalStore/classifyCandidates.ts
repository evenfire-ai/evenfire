import { type CandidateId, type CandidateManifest, CanonicalStoreError } from './types'

export function classifyCandidates(candidates: CandidateManifest[]): {
  selected: CandidateId
  decision: 'SingleCandidate' | 'EquivalentCandidates' | 'EmptyCandidateRetired'
} {
  if (candidates.length === 0 || candidates.some(candidate => !candidate.inspection))
    throw new CanonicalStoreError('CandidateIncomplete')
  const ordered = [...candidates].sort((a, b) => {
    const rank = (id: CandidateId) =>
      id === 'C_state' ? 0 : id === 'C_root' ? 1 : id === 'C_ws' ? 2 : 3
    return rank(a.id) - rank(b.id) || a.id.localeCompare(b.id)
  })
  const populated = ordered.filter(candidate => !candidate.inspection!.empty)
  const considered = populated.length > 0 ? populated : ordered
  const hashes = new Set(considered.map(candidate => candidate.inspection!.catalogHash))
  if (hashes.size !== 1) throw new CanonicalStoreError('DivergentCandidates')
  const identities = candidates.filter(candidate => candidate.inspection!.identity)
  if (identities.length > 0 && candidates.some(candidate => candidate.id !== identities[0].id)) {
    throw new CanonicalStoreError('ForeignCandidateAfterCanonical')
  }
  return {
    selected: considered[0].id,
    decision:
      candidates.length === 1
        ? 'SingleCandidate'
        : populated.length > 0 && populated.length < candidates.length
          ? 'EmptyCandidateRetired'
          : 'EquivalentCandidates',
  }
}
