#!/bin/bash
# Shared environment for the gate wrappers in this folder (sourced, not run).
#
# gate_repo_from_origin prints owner/name for the github.com origin of the current
# directory's clone, and returns 1 when there is no origin or it is not on github.com.
# gate_prepare_env sets GITHUB_REPOSITORY from that when it is unset, and GH_TOKEN from
# `gh auth token` when it is unset. It exits 2 when the repository cannot be derived and
# no --repo flag was passed, so a session never runs a gate against the wrong repository.

gate_repo_from_origin() {
  local url slug
  url=$(git remote get-url origin 2>/dev/null) || return 1
  case "$url" in
    git@github.com:*) slug=${url#git@github.com:} ;;
    ssh://git@github.com/*) slug=${url#ssh://git@github.com/} ;;
    https://github.com/*) slug=${url#https://github.com/} ;;
    http://github.com/*) slug=${url#http://github.com/} ;;
    *) return 1 ;;
  esac
  slug=${slug%/}
  slug=${slug%.git}
  case "$slug" in
    */*/*|*/|/*|*/) return 1 ;;
    */*) printf '%s\n' "$slug" ;;
    *) return 1 ;;
  esac
}

gate_has_repo_flag() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --repo|--repo=*) return 0 ;;
    esac
  done
  return 1
}

gate_prepare_env() {
  local name=$1
  shift
  local repo token
  if [ -z "${GITHUB_REPOSITORY:-}" ]; then
    if repo=$(gate_repo_from_origin); then
      export GITHUB_REPOSITORY="$repo"
    elif ! gate_has_repo_flag "$@"; then
      echo "$name: GITHUB_REPOSITORY is unset and the origin remote of $(pwd) is not a github.com repository." >&2
      echo "$name: run it from a clone with a github.com origin, or pass --repo owner/name." >&2
      exit 2
    fi
  fi
  if [ -z "${GH_TOKEN:-}" ]; then
    if token=$(gh auth token 2>/dev/null) && [ -n "$token" ]; then
      export GH_TOKEN="$token"
    fi
  fi
}
