## Summary
- Detects 3× consecutive 401s from chatllm.
- Emits an `auth-expired` event so the desktop app refreshes its RPC token mid-stream.

## Test plan
- [x] Unit tests pass
- [x] Manual verification on minikube
