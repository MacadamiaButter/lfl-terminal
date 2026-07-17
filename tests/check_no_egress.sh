#!/usr/bin/env bash
# tests/check_no_egress.sh - static grep gate: network-capable APIs must
# appear ONLY in the one file allowed to make a network call
# (extension/background/service-worker.js). Everything else in extension/
# must be free of them. Exits nonzero on any violation.
#
# Pattern coverage (2026-07 security review SHOULD-FIX #6 - widened from the
# original fetch/XMLHttpRequest/WebSocket/sendBeacon-only grep, which missed
# several other network-capable browser APIs and common fetch-aliasing
# tricks):
#   - fetch(                     direct fetch call
#   - XMLHttpRequest             legacy AJAX
#   - WebSocket                  socket egress
#   - sendBeacon / navigator.sendBeacon   fire-and-forget egress
#   - EventSource                 SSE egress
#   - RTCPeerConnection           WebRTC (can egress even off explicit fetch)
#   - WebTransport                 newer QUIC-based egress API
#   - import(                     dynamic import can load a remote module URL
#   - .src =                      assigning an element .src can trigger a
#                                  fetch (img/script/iframe/etc.)
#   - = fetch / fetch]            aliasing fetch to a local name to dodge a
#                                  naive `fetch(` grep (e.g. `const f = fetch;`
#                                  or destructuring `const {fetch} = window;`)
#
# P4 posture widening (2026-07-16, LFL-TERMINAL-MEMBER-EXPERIENCE-DESIGN.md
# §6, owner sign-off E condition: Fable security review required). E5's
# `status` command adds a SECOND fetch() call site inside service-worker.js
# (a loopback GET /health + best-effort GET /v1/models, alongside the
# pre-existing model-lane POST) - the guarantee this file's own comment used
# to describe ("exactly one fetch/XHR/... call site, and it's the loopback
# model endpoint") is no longer literally "one call site", so it is now
# checked as "every call site, individually proven loopback-only" instead -
# see tests/check_sw_fetch_loopback.js, invoked at the end of this script,
# for the mechanical proof (not just this comment's say-so).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="${ROOT}/extension"
ALLOWED_FILE="extension/background/service-worker.js"

PATTERN='fetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|RTCPeerConnection|WebTransport|import\(|\.src[[:space:]]*=|=[[:space:]]*fetch\b|\bfetch[[:space:]]*\]'

echo "scanning ${EXT_DIR} for network APIs outside ${ALLOWED_FILE} ..."

VIOLATIONS="$(grep -rnE "${PATTERN}" "${EXT_DIR}" \
  --include='*.js' \
  | grep -v "^${EXT_DIR}/background/service-worker.js:" || true)"

if [[ -n "${VIOLATIONS}" ]]; then
  echo "FAIL: network API usage found outside the allowed loopback client:" >&2
  echo "${VIOLATIONS}" >&2
  exit 1
fi

if ! grep -qE "${PATTERN}" "${EXT_DIR}/background/service-worker.js"; then
  echo "WARN: expected at least one network API call in ${ALLOWED_FILE}, found none." >&2
  exit 1
fi

echo "PASS: no network API usage outside ${ALLOWED_FILE}."

echo "checking every fetch() call site inside ${ALLOWED_FILE} resolves to a 127.0.0.1 loopback URL ..."
node "${ROOT}/tests/check_sw_fetch_loopback.js"
