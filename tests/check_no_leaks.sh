#!/usr/bin/env bash
# tests/check_no_leaks.sh — pre-publish hygiene gate for an open-core repo.
#
# Greps every TRACKED file in the repo for a small set of identity/infra
# strings that must never end up in a public commit (dev-machine hostnames,
# local absolute paths, internal project codenames, personal contact info,
# and the like). This is a generic hygiene gate, not a description of any
# specific pattern below — see the array itself if you need to know exactly
# what it checks for. Exits 0 with a PASS line when nothing matches, exits 1
# and prints every offending line otherwise.
#
# Same style as tests/check_no_egress.sh: a static grep gate, no framework,
# runs in well under a second, safe to wire into a pre-push hook or CI.
#
# IMPORTANT — this script is itself a tracked file, and it necessarily
# contains the leak patterns as literal text (how else would it grep for
# them?). It excludes ITSELF by path from the scan below so it can never
# trip its own check; every other tracked file is fair game, patterns
# included, with no other exclusions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF_PATH="tests/check_no_leaks.sh"

cd "${ROOT}"

# Extendable pattern list — add new identity/infra strings here as they turn
# up. Kept as plain array entries (not a single pre-joined regex literal) so
# it's easy to scan, diff, and extend one line at a time.
LEAK_PATTERNS=(
  'butter-ubuntu'
  'QweClau'
  '/home/'
  'supervised-ops-demo'
  'OWCsecure'
  'main-ubuntu'
  'meltedrubberducky'
  '@proton'
  'hybrid/workspace'
)

# Build one alternation regex for a single grep pass over the whole tree.
REGEX="$(IFS='|'; echo "${LEAK_PATTERNS[*]}")"

echo "scanning tracked files for pre-publish identity/infra leaks ..."

VIOLATIONS="$(git grep -nIE "${REGEX}" -- . ":!${SELF_PATH}" || true)"

if [[ -n "${VIOLATIONS}" ]]; then
  echo "FAIL: possible identity/infra leak(s) found in tracked files:" >&2
  echo "${VIOLATIONS}" >&2
  exit 1
fi

echo "PASS: no identity/infra leak patterns found in tracked files."
