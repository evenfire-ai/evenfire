#!/usr/bin/env bash
# Side-effect-free Minikube status predicates shared by startup and T2.

minikube_profile_status_component_is_running() {
  local status="$1" component="$2" json_component="$3"

  case "$status" in
    *"${component}: Running"*|*"${json_component}: Running"*) return 0 ;;
  esac
  [[ "$status" =~ \"${json_component}\"[[:space:]]*:[[:space:]]*\"Running\" ]]
}

minikube_profile_status_is_healthy() {
  local status="$1"

  [ -n "$status" ] || return 1
  minikube_profile_status_component_is_running "$status" host Host || return 1
  minikube_profile_status_component_is_running "$status" kubelet Kubelet || return 1
  minikube_profile_status_component_is_running "$status" apiserver APIServer || return 1
  [[ "$status" != *Stopped* ]] || return 1
  [[ "$status" != *Nonexistent* ]] || return 1
  [[ "$status" != *'does not exist'* ]] || return 1
  [[ "$status" != *'not found'* ]] || return 1
}

minikube_profile_status_is_missing_or_stopped() {
  local status="$1"

  [ -z "$status" ] ||
    [[ "$status" == *Stopped* ||
      "$status" == *Nonexistent* ||
      "$status" == *'does not exist'* ||
      "$status" == *'not found'* ]]
}
