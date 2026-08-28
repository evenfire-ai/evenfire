---
name: minikube-t0-t1-t2
description: Certifies local Minikube T0/T1/T2 lanes for the Evenfire repository. Use when the user asks to run, close, or certify T0, T1, T2, "cierra T2", minikube-t2, certification, preflight, pre-gate-sync, or Real PostgreSQL suites.
---

# Minikube T0/T1/T2 certification (pointer)

The canonical copy of this skill lives at
`.cursor/skills/minikube-t0-t1-t2/SKILL.md` (workflow, checklist, decision
tree) with `.cursor/skills/minikube-t0-t1-t2/reference.md` (anti-patterns,
failure codes, recovery). Read and follow those files; do not duplicate their
content here.

Non-negotiable entrypoint rule: use the public Make orchestrator for T2.
Never invoke `pre-gate-sync` standalone with `GATE=minikube-t2`; that reserved
delegation is accepted only from `t2.sh` with its inherited lease. Use
`make minikube-t2-preflight` only to plan and `make minikube-t2-runtime` only
after the documented exact-head T0/T1 preconditions.
