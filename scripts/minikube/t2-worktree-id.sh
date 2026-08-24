#!/usr/bin/env bash
# Shared deterministic worktree identity for the local T2 mutation contract.

t2_worktree_id() {
  printf '%s' "$1" | shasum | awk '{print $1}'
}
