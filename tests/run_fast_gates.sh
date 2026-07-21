#!/usr/bin/env bash
# tests/run_fast_gates.sh - the single command CI (and any human) runs to
# get a fast, deterministic, zero-network pass/fail on this repo: every
# tests/*.test.js suite, the static hygiene/egress gates, manifest JSON
# sanity, and the manifest/store-asset drift gates. Meant to be fast enough
# to run on every push and safe to run from any cwd.
#
# Same style as tests/check_no_egress.sh / check_no_leaks.sh: plain bash,
# no framework, exits nonzero on any failure with a clear summary.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

FAILURES=()

run_check() {
  local label="$1"
  shift
  echo
  echo "=== ${label} ==="
  if "$@"; then
    echo "--- ${label}: PASS ---"
  else
    echo "--- ${label}: FAIL ---" >&2
    FAILURES+=("${label}")
  fi
}

# 1. every self-contained node test suite under tests/*.test.js
while IFS= read -r -d '' suite; do
  name="tests/$(basename "${suite}")"
  run_check "${name}" node "${suite}"
done < <(find "${ROOT}/tests" -maxdepth 1 -name '*.test.js' -print0 | sort -z)

# 2. static shell gates
run_check "tests/check_no_egress.sh" bash "${ROOT}/tests/check_no_egress.sh"
run_check "tests/check_no_leaks.sh" bash "${ROOT}/tests/check_no_leaks.sh"
run_check "tests/check_no_emdash.sh" bash "${ROOT}/tests/check_no_emdash.sh"

# 3. manifest JSON sanity: valid JSON, manifest_version 3, semver-shaped version
run_check "manifest JSON sanity" node -e "
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('${ROOT}/extension/manifest.json', 'utf8'));
if (manifest.manifest_version !== 3) {
  throw new Error('manifest_version is ' + manifest.manifest_version + ', expected 3');
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+\$/.test(manifest.version || '')) {
  throw new Error('version ' + JSON.stringify(manifest.version) + ' does not match ^d+.d+.d+\$');
}
console.log('manifest.json is valid JSON, manifest_version=3, version=' + manifest.version);
"

# 4. manifest permission-drift gate
run_check "tests/check_manifest_baseline.js" node "${ROOT}/tests/check_manifest_baseline.js"

# 5. store/icon asset presence + exact-dimension gate
run_check "tests/check_store_assets.js" node "${ROOT}/tests/check_store_assets.js"

echo
echo "================================================================"
if [[ "${#FAILURES[@]}" -eq 0 ]]; then
  echo "FAST GATES: PASS (all checks green)"
  exit 0
else
  echo "FAST GATES: FAIL (${#FAILURES[@]} check(s) failed):" >&2
  for f in "${FAILURES[@]}"; do
    echo "  - ${f}" >&2
  done
  exit 1
fi
