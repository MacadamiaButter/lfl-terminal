#!/usr/bin/env bash
# tools/build-release.sh - deterministic release builder.
#
# Builds dist/lfl-terminal-$VERSION.zip straight from the git tree at HEAD
# (never the working tree - a dirty tree is refused outright), so the
# artifact is exactly what is committed, byte-for-byte reproducible, and
# free of any build-machine timestamp or path leakage. Also writes a
# sidecar dist/release-manifest-$VERSION.json recording the source commit,
# the exact build command, the artifact hash, and its file list.
#
# Refuses to run (and refuses to overwrite an existing artifact for the
# same version unless it is byte-identical) rather than silently doing
# something a human did not ask for - same posture as the other gates in
# this repo (check_no_egress.sh / check_no_leaks.sh / check_no_emdash.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

DIST_DIR="${ROOT}/dist"
BUILD_COMMAND="git archive --format=zip --mtime=@\$COMMIT_EPOCH --output dist/lfl-terminal-\$VERSION.zip HEAD:extension"

echo "=== build-release: preflight ==="

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FAIL: not inside a git work tree." >&2
  exit 1
fi

DIRTY="$(git status --porcelain)"
if [[ -n "${DIRTY}" ]]; then
  echo "FAIL: working tree is not clean, refusing to build a release from it:" >&2
  echo "${DIRTY}" >&2
  exit 1
fi

if ! git cat-file -e HEAD:extension/manifest.json 2>/dev/null; then
  echo "FAIL: HEAD does not contain extension/manifest.json." >&2
  exit 1
fi

MANIFEST_AT_HEAD="$(git show HEAD:extension/manifest.json)"

VERSION="$(node -e "
const m = JSON.parse(process.argv[1]);
if (!/^[0-9]+\.[0-9]+\.[0-9]+\$/.test(m.version || '')) {
  process.stderr.write('manifest.version ' + JSON.stringify(m.version) + ' is not a valid semver-shaped version\n');
  process.exit(1);
}
process.stdout.write(m.version);
" "${MANIFEST_AT_HEAD}")"

echo "source manifest version at HEAD: ${VERSION}"

SOURCE_COMMIT="$(git rev-parse HEAD)"

# git archive's zip writer stamps every entry with the CURRENT wall-clock
# time by default (unlike its tar writer), which would make the artifact
# non-reproducible run to run. Pin every entry's mtime to the committer
# timestamp of the last commit that TOUCHED extension/ (not HEAD's), so
# the artifact is byte-identical regardless of when or where it is built,
# and also stable across commits that never change the extension (docs,
# tests, workflows).
COMMIT_EPOCH="$(git log -1 --format=%ct "${SOURCE_COMMIT}" -- extension)"

TAG="v${VERSION}"
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null 2>&1; then
  TAG_COMMIT="$(git rev-parse "refs/tags/${TAG}^{commit}")"
  if [[ "${TAG_COMMIT}" != "${SOURCE_COMMIT}" ]]; then
    echo "FAIL: tag ${TAG} already exists and points at a different commit (${TAG_COMMIT}, HEAD is ${SOURCE_COMMIT})." >&2
    echo "      a release for version ${VERSION} was already tagged elsewhere - bump the version." >&2
    exit 1
  fi
  echo "tag ${TAG} already exists and points at HEAD - fine, continuing."
fi

echo
echo "=== build-release: running tests/run_fast_gates.sh ==="
if ! bash "${ROOT}/tests/run_fast_gates.sh"; then
  echo "FAIL: tests/run_fast_gates.sh did not pass, refusing to build a release." >&2
  exit 1
fi

mkdir -p "${DIST_DIR}"

ARTIFACT_NAME="lfl-terminal-${VERSION}.zip"
ARTIFACT_PATH="${DIST_DIR}/${ARTIFACT_NAME}"
MANIFEST_OUT_NAME="release-manifest-${VERSION}.json"
MANIFEST_OUT_PATH="${DIST_DIR}/${MANIFEST_OUT_NAME}"

TMP_ARTIFACT="$(mktemp "${DIST_DIR}/.build-${VERSION}.XXXXXX.zip")"
cleanup() { rm -f "${TMP_ARTIFACT}"; }
trap cleanup EXIT

echo
echo "=== build-release: building artifact ==="
git archive --format=zip --mtime="@${COMMIT_EPOCH}" --output "${TMP_ARTIFACT}" HEAD:extension

NEW_SHA256="$(sha256sum "${TMP_ARTIFACT}" | awk '{print $1}')"

if [[ -e "${ARTIFACT_PATH}" ]]; then
  OLD_SHA256="$(sha256sum "${ARTIFACT_PATH}" | awk '{print $1}')"
  if [[ "${OLD_SHA256}" != "${NEW_SHA256}" ]]; then
    echo "FAIL: ${ARTIFACT_PATH} already exists with a different contents (sha256 ${OLD_SHA256} vs freshly built ${NEW_SHA256})." >&2
    echo "      an existing release artifact must never be overwritten with different bytes - increment the version instead." >&2
    exit 1
  fi
  echo "existing ${ARTIFACT_NAME} is byte-identical to a fresh build - leaving it in place."
else
  mv "${TMP_ARTIFACT}" "${ARTIFACT_PATH}"
  trap - EXIT
  cleanup() { :; }
fi

echo "sha256: ${NEW_SHA256}"

FILE_COUNT="$(unzip -Z1 "${ARTIFACT_PATH}" | wc -l | tr -d ' ')"
FILES_JSON="$(unzip -Z1 "${ARTIFACT_PATH}" | sort | node -e "
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (l) => { if (l.length > 0) lines.push(l); });
rl.on('close', () => { process.stdout.write(JSON.stringify(lines)); });
")"

echo
echo "=== build-release: writing release manifest ==="
node -e "
const fs = require('fs');
const out = {
  schema: 'lfl-release-manifest/1',
  name: 'lfl-terminal',
  version: process.argv[1],
  source_commit: process.argv[2],
  build_command: process.argv[3],
  artifact: process.argv[4],
  sha256: process.argv[5],
  file_count: Number(process.argv[6]),
  files: JSON.parse(process.argv[7]),
  built_at_source: 'commit-timestamp-derived (deterministic)',
};
fs.writeFileSync(process.argv[8], JSON.stringify(out, null, 2) + '\n');
" "${VERSION}" "${SOURCE_COMMIT}" "${BUILD_COMMAND}" "${ARTIFACT_NAME}" "${NEW_SHA256}" "${FILE_COUNT}" "${FILES_JSON}" "${MANIFEST_OUT_PATH}"

echo "wrote ${MANIFEST_OUT_PATH}"
echo
echo "================================================================"
echo "BUILD-RELEASE: PASS (version ${VERSION}, sha256 ${NEW_SHA256})"
