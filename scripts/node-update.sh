#!/usr/bin/env bash
# Install or patch a user-owned Node on the Mac, no sudo (plan row 3.20k).
#
#   scripts/node-update.sh <major> [--check] [--link-shell]
#
#   <major>        22 or 24. 24 is what the LaunchAgents run (ship-bot, capacity, herdr-reconcile, through
#                  scripts/lib/resolve-node.sh); 22 is the shells' Node.
#   --check        read-only: print the installed and the latest patch of that line. Exit 0 current,
#                  1 behind or not installed, 2 the lookup failed. Nothing is downloaded or written.
#   --link-shell   also point ~/.local/bin/node, npm and npx at the stable <major> link, so a new shell
#                  follows the patch too.
#
# Layout under $NODE_ROOT (default ~/.local/share/node):
#   v24.22.3/        one directory per installed patch, from the official tarball
#   24 -> v24.22.3   stable link. Agents and shells name this path, so a patch is one atomic link swap.
# The previous patch stays until the next run, so a bad patch rolls back with the line printed at the end.
#
# The tarball comes from $NODE_DIST_BASE (default https://nodejs.org/dist) and its SHA-256 is checked
# against that release's SHASUMS256.txt. That list comes from the same host over TLS, so it catches a
# damaged or swapped file, not a compromise of nodejs.org itself. Nothing here needs sudo, and
# /usr/local/bin/node is never touched: the owner removes the old .pkg after `ps` shows the new Node.
# Running agents keep their old binary until their next start (ship-bot starts every 2 minutes).
set -euo pipefail

BASE="${NODE_DIST_BASE:-https://nodejs.org/dist}"
ROOT="${NODE_ROOT:-${HOME}/.local/share/node}"
BIN="${NODE_SHELL_BIN:-${HOME}/.local/bin}"

usage() {
  echo "usage: node-update.sh <22|24> [--check] [--link-shell]" >&2
  exit 64
}

major="" check=0 link_shell=0
for a in "$@"; do
  case "$a" in
    --check) check=1 ;;
    --link-shell) link_shell=1 ;;
    22 | 24) major="$a" ;;
    *) usage ;;
  esac
done
[[ -n "${major}" ]] || usage

# NODE_PLATFORM names the tarball's platform suffix; the tests set it so they run on Linux CI too.
case "${NODE_PLATFORM:-$(uname -s)-$(uname -m)}" in
  Darwin-arm64 | darwin-arm64) plat="darwin-arm64" ;;
  Darwin-x86_64 | darwin-x64) plat="darwin-x64" ;;
  *) echo "node-update: this script is for the Mac (got $(uname -s) $(uname -m))." >&2; exit 2 ;;
esac

work="$(mktemp -d "${TMPDIR:-/tmp}/node-update.XXXXXX")"
cleanup() { rm -rf "${work}"; }
trap cleanup EXIT

# Newest patch of the line and its published checksum.
sums="${work}/SHASUMS256.txt"
if ! curl -fsSL --max-time 60 -o "${sums}" "${BASE}/latest-v${major}.x/SHASUMS256.txt"; then
  echo "node-update: could not read ${BASE}/latest-v${major}.x/SHASUMS256.txt" >&2
  exit 2
fi
tarball="$(awk -v p="${plat}" '$2 ~ "^node-v[0-9.]+-" p "\\.tar\\.gz$" { print $2 }' "${sums}" | head -1)"
want_sum="$(awk -v t="${tarball}" '$2 == t { print $1 }' "${sums}")"
if [[ -z "${tarball}" || ! "${want_sum}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "node-update: no ${plat} tarball with a SHA-256 in that list. Nothing changed." >&2
  exit 2
fi
latest="${tarball#node-}"
latest="${latest%-${plat}.tar.gz}" # v24.22.3
if ! [[ "${latest}" =~ ^v${major}\.[0-9]+\.[0-9]+$ ]]; then
  echo "node-update: the list named ${latest}, which is not in line ${major}. Nothing changed." >&2
  exit 2
fi

link="${ROOT}/${major}"
current=""
if [[ -L "${link}" ]]; then current="$(basename "$(readlink "${link}")")"; fi

if [[ "${check}" -eq 1 ]]; then
  echo "node ${major}: installed ${current:-none}, latest ${latest}"
  [[ "${current}" == "${latest}" ]] && exit 0
  exit 1
fi

mkdir -p "${ROOT}"
# Atomic: rename a fresh link over the stable one (python3 ships with macOS developer tools).
swap_link() { # swap_link <target> <linkpath>
  local tmp="${2}.new.$$"
  ln -s "$1" "${tmp}"
  python3 -c 'import os,sys; os.replace(sys.argv[1], sys.argv[2])' "${tmp}" "$2"
}

if [[ ! -x "${ROOT}/${latest}/bin/node" ]]; then
  echo "downloading ${tarball}"
  curl -fsSL --max-time 600 -o "${work}/${tarball}" "${BASE}/latest-v${major}.x/${tarball}"
  got_sum="$(shasum -a 256 "${work}/${tarball}" | awk '{ print $1 }')"
  if [[ "${got_sum}" != "${want_sum}" ]]; then
    echo "node-update: SHA-256 mismatch for ${tarball} (got ${got_sum}, list says ${want_sum}). Nothing installed." >&2
    exit 1
  fi
  mkdir "${work}/x"
  tar -xzf "${work}/${tarball}" -C "${work}/x"
  src="${work}/x/node-${latest}-${plat}"
  if [[ "$("${src}/bin/node" --version 2>/dev/null || true)" != "${latest}" ]]; then
    echo "node-update: the unpacked node does not report ${latest}. Nothing installed." >&2
    exit 1
  fi
  # npm's global prefix lives in the install's etc/npmrc; keep the line's setting (prefix=~/.local).
  if [[ -n "${current}" && -f "${ROOT}/${current}/etc/npmrc" && ! -e "${src}/etc/npmrc" ]]; then
    mkdir -p "${src}/etc"
    cp "${ROOT}/${current}/etc/npmrc" "${src}/etc/npmrc"
  fi
  mv "${src}" "${ROOT}/${latest}.part"
  mv "${ROOT}/${latest}.part" "${ROOT}/${latest}"
else
  echo "${latest} is already unpacked in ${ROOT}"
fi

swap_link "${latest}" "${link}"
[[ "$("${link}/bin/node" --version)" == "${latest}" ]] || { echo "node-update: ${link}/bin/node does not report ${latest}." >&2; exit 1; }

if [[ "${link_shell}" -eq 1 ]]; then
  mkdir -p "${BIN}"
  for t in node npm npx; do swap_link "${link}/bin/${t}" "${BIN}/${t}"; done
fi

# Keep the new patch, the one before it, and anything a link in the shell bin still names.
keep=" ${latest} ${current} "
for t in node npm npx; do
  if [[ -L "${BIN}/${t}" ]]; then
    d="$(readlink "${BIN}/${t}")"
    d="${d#${ROOT}/}"
    keep="${keep}${d%%/*} "
  fi
done
for d in "${ROOT}"/v"${major}".*; do
  [[ -d "${d}" ]] || continue
  b="$(basename "${d}")"
  [[ "${keep}" == *" ${b} "* ]] || { rm -rf "${d}"; echo "removed old ${b}"; }
done

echo "node ${major}: ${current:-none} -> ${latest} (${link})"
if [[ -n "${current}" && "${current}" != "${latest}" && -d "${ROOT}/${current}" ]]; then
  echo "rollback: ln -sfn ${current} ${link}"
fi
