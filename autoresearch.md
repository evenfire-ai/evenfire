# AutoResearch: Reduce Minikube startup overhead while preserving strict branch-profile ownership and readiness gates

## Objective
Reduce Minikube startup overhead while preserving strict branch-profile ownership and readiness gates

## Metric
- Primary: evenfire_minikube_healthy_start_calls (lower is better)
- Baseline policy: initial

## Scope
scripts/minikube/start.sh,scripts/minikube/t2-common.sh,scripts/minikube/profile-readiness.sh,scripts/tests/test-minikube-profile-readiness.sh,scripts/tests/test-minikube-t2-scenarios.sh

## Commands
- Benchmark: `PYTHONDONTWRITEBYTECODE=1 bash scripts/tests/test-minikube-profile-readiness.sh`
- Checks: `bash scripts/tests/test-minikube-t2-scenarios.sh`

## Safety
Codex main decides. Scorecards and gates decide keep/discard. RED content must not be logged.
