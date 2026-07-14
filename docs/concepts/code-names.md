# Code names: evenfire vs clerum

**evenfire** is the public product name. **clerum** is the historical internal
code name that still appears in APIs and repositories.

| Layer | What you see |
| --- | --- |
| Product, docs, marketing, GitHub org | **evenfire** |
| Kubernetes API group | `clerum.io` |
| Environment variables | `CLERUM_*` |
| Helm chart / package names | `clerum-crds`, `clerum-*` |
| Some service logs and labels | `clerum` |

These are the same project. When a guide says “create a Host CRD” or “set
`CLERUM_MODEL_PROVIDER`”, that is the evenfire platform.
