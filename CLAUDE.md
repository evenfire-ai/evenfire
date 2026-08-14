# Evenfire repository guidance

## Branch naming

Never create new branches with agent or vendor prefixes such as `codex/*`,
`claude/*`, `openai/*`, `anthropic/*`, `antrophic/*`, or any other Frontier
Labs reference. Use the repository's conventional prefixes instead: `feat/*`,
`fix/*`, `hotfix/*`, `chore/*`, `docs/*`, `test/*`, `refactor/*`, `ci/*`,
`build/*`, `perf/*`, or `revert/*`.

The local Minikube T0/T1/T2 contract is development-only. Follow the
canonical `make minikube-t2-preflight` and `make minikube-t2` entry points and
the ownership, secret-safety, and evidence rules in `AGENTS.md`.
