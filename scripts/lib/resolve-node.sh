#!/usr/bin/env bash
# Pick the Node binary a LaunchAgent will run (14 November 2026, ship-bot/INCIDENTS.md).
#
#   source scripts/lib/resolve-node.sh; NODE_BIN="$(resolve_node)" || exit 1
#
# The agents (ship-bot, capacity) used `node -p process.execPath`, which on this Mac was a symlink
# Hermes Agent's installer made to its private Node under ~/.hermes. Archiving Hermes would have
# silently stopped the only merger. So:
#   - NODE_BIN=<path> overrides everything (still must be Node 22 or newer);
#   - otherwise the first of $HOME/.local/share/node/24/bin/node (the user-owned install, plan row 3.20k;
#     scripts/node-update.sh patches it without sudo), /usr/local/bin/node (the old .pkg, until the owner
#     removes it), /opt/homebrew/bin/node and the PATH's node whose realpath is NOT inside another tool's
#     private folder ($HOME/.<name>/...) and is Node 22+;
#   - no such binary: a message on stderr and a non-zero exit. Never a silent fallback.
# Prints the candidate's own path (not its realpath) on stdout, so launchd follows a stable symlink. HOME and the candidate list are read at call time (tests set them).

NODE_MIN_MAJOR=22

# Real path of a file, following every symlink; empty when it does not resolve.
_rn_realpath() {
  python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1" 2>/dev/null || true
}

# True when $1 (a realpath) lies under a dot-folder of $HOME (another tool's private area). $HOME is
# compared both as given and with its symlinks resolved (`pwd -P`): a symlinked home would otherwise
# never match. The one dot-folder path that is ours is the Node installs scripts/node-update.sh makes
# (plan row 3.20k), and only when the candidate $2, as written, is the stable link
# $HOME/.local/share/node/<major>/bin/node and it resolves into a v<version> directory there. The
# shell's ~/.local/bin/node points into the same folder but is not that link, so it stays refused:
# the 14 November incident was a PATH node silently becoming the agents' Node.
_rn_private() {
  local home_phys
  home_phys="$(cd "${HOME}" 2>/dev/null && pwd -P)" || home_phys="${HOME}"
  case "$2" in
    # The pattern has no wildcard, so a candidate with ".." (or any extra segment) cannot match it.
    "${HOME}"/.local/share/node/[0-9][0-9]/bin/node)
      case "$1" in
        "${HOME}"/.local/share/node/v[0-9]*/bin/node | "${home_phys}"/.local/share/node/v[0-9]*/bin/node) return 1 ;;
      esac
      ;;
  esac
  case "$1" in
    "${HOME}"/.*/* | "${home_phys}"/.*/*) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_node() {
  local override="${NODE_BIN:-}" cand real major seen_private=""
  if [[ -n "${override}" ]]; then
    real="$(_rn_realpath "${override}")"
    if [[ -z "${real}" || ! -x "${real}" ]]; then
      echo "resolve-node: NODE_BIN=${override} is not an executable file." >&2
      return 1
    fi
    major="$("${real}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if ! [[ "${major}" =~ ^[0-9]+$ && "${major}" -ge "${NODE_MIN_MAJOR}" ]]; then
      echo "resolve-node: needs Node ${NODE_MIN_MAJOR} or newer; NODE_BIN=${override} is $("${real}" --version 2>/dev/null || echo unknown)." >&2
      return 1
    fi
    echo "${override}" # the path as given: a stable symlink survives upgrades
    return 0
  fi
  # RESOLVE_NODE_CANDIDATES (space-separated) replaces the two fixed paths; for tests.
  local candidates
  read -r -a candidates <<<"${RESOLVE_NODE_CANDIDATES:-${HOME}/.local/share/node/24/bin/node /usr/local/bin/node /opt/homebrew/bin/node}"
  if cand="$(command -v node 2>/dev/null)" && [[ -n "${cand}" ]]; then candidates+=("${cand}"); fi
  for cand in "${candidates[@]}"; do
    if [[ "${cand}" == "${HOME}"/.local/share/node/[0-9][0-9]/bin/node && ! -e "${cand}" ]]; then
      if [[ -L "${cand%/bin/node}" && ! -e "${cand%/bin/node}" ]]; then
        echo "resolve-node: ${cand%/bin/node} is a link to nothing (the install it named is gone). Run scripts/node-update.sh again, or set NODE_BIN=<path>." >&2
        return 1
      fi
      if [[ -e "${cand%/bin/node}" ]]; then
        echo "resolve-node: ${cand%/bin/node} exists but has no bin/node (a damaged install). Run scripts/node-update.sh again, or set NODE_BIN=<path>." >&2
        return 1
      fi
    fi
    [[ -e "${cand}" ]] || continue
    real="$(_rn_realpath "${cand}")"
    [[ -n "${real}" && -x "${real}" ]] || continue
    if _rn_private "${real}" "${cand}"; then
      seen_private="${seen_private:-${cand} -> ${real}}"
      continue
    fi
    major="$("${real}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [[ "${major}" -ge "${NODE_MIN_MAJOR}" ]] || continue
    echo "${cand}" # the stable path, not its versioned realpath (a brew upgrade removes old kegs)
    return 0
  done
  if [[ -n "${seen_private}" ]]; then
    echo "resolve-node: refusing ${seen_private}: it lives in another tool's private folder, and archiving that tool would stop this agent. Install Node ${NODE_MIN_MAJOR}+ outside \$HOME/.*/ (run scripts/node-update.sh 24), or set NODE_BIN=<path> to choose one on purpose." >&2
  else
    echo "resolve-node: no Node ${NODE_MIN_MAJOR}+ found in ~/.local/share/node/24, /usr/local/bin, /opt/homebrew/bin or PATH. Run scripts/node-update.sh 24, or set NODE_BIN=<path>." >&2
  fi
  return 1
}
