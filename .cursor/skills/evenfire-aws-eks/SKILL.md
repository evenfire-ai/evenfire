---
name: evenfire-aws-eks
description: Deploy Evenfire into an existing Amazon EKS cluster from the public repo (kustomize on deploy/base + GHCR images at an official release tag). Use when the user asks to install Evenfire/Clerum on AWS or EKS. Not for minikube T0/T1/T2, new clusters, or GKE/evenfire-infra.
---

# Evenfire on existing EKS (pointer)

The canonical copy of this skill lives at `.agents/skills/evenfire-aws-eks/`
(`SKILL.md`, `references/`, `scripts/`), because the customer's own coding agent
reads it from a clone of this repository. Read and follow those files; do not
duplicate their content here.

Full procedure: `docs/deploy/aws-eks-agent-guide.md`.
