#!/usr/bin/env bash
# server/launch-dev.sh - start the LOCAL llama.cpp server for lfl-terminal M1.
#
# CPU only (-ngl 0): the GPU is running production services on this box and is
# off-limits for this spike. Binds 127.0.0.1:1238 ONLY - never touch/restart
# anything on 1234/1236/1237/4101.
#
# Configure via env vars (no defaults are baked in - this is deliberate, so
# the script fails closed instead of silently pointing at someone else's
# path):
#   LLAMA_SERVER_DIR  - directory containing the llama-server binary
#   LLAMA_MODEL_PATH  - path to the GGUF model file
#
# For local dev convenience, if a gitignored server/.env.local exists next to
# this script, it is sourced automatically (put your real paths there -
# never commit it):
#   LLAMA_SERVER_DIR=/path/to/llama-server-dir
#   LLAMA_MODEL_PATH=/path/to/model.gguf
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
if [[ -f "${SCRIPT_DIR}/.env.local" ]]; then
  source "${SCRIPT_DIR}/.env.local"
fi

if [[ -z "${LLAMA_SERVER_DIR:-}" ]]; then
  echo "ERROR: LLAMA_SERVER_DIR is not set." >&2
  echo "       Set it to the directory containing your llama-server binary, e.g.:" >&2
  echo "         export LLAMA_SERVER_DIR=/path/to/llama-vulkan-2.24.0" >&2
  echo "       (or create server/.env.local with LLAMA_SERVER_DIR=... - gitignored, never committed)" >&2
  exit 1
fi
if [[ -z "${LLAMA_MODEL_PATH:-}" ]]; then
  echo "ERROR: LLAMA_MODEL_PATH is not set." >&2
  echo "       Set it to the path of your GGUF model file, e.g.:" >&2
  echo "         export LLAMA_MODEL_PATH=/path/to/gguf/Qwen3-4B-Instruct-2507-Q5_K_M.gguf" >&2
  echo "       (or create server/.env.local with LLAMA_MODEL_PATH=... - gitignored, never committed)" >&2
  exit 1
fi

SERVER_DIR="${LLAMA_SERVER_DIR}"
SERVER_BIN="${SERVER_DIR}/llama-server"
MODEL_PATH="${LLAMA_MODEL_PATH}"
HOST="127.0.0.1"
PORT="1238"
LOG_FILE="${SCRIPT_DIR}/dev.log"

if [[ ! -x "${SERVER_BIN}" ]]; then
  echo "ERROR: server binary not found or not executable at ${SERVER_BIN}" >&2
  exit 1
fi
if [[ ! -f "${MODEL_PATH}" ]]; then
  echo "ERROR: model not found at ${MODEL_PATH}" >&2
  exit 1
fi

if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "ERROR: something is already bound to :${PORT} - refusing to start a second server." >&2
  echo "       (this script only ever targets 127.0.0.1:${PORT}; it will not touch any other port)" >&2
  exit 1
fi

echo "starting llama-server on ${HOST}:${PORT} (CPU, -ngl 0) ..."
echo "  bin:   ${SERVER_BIN}"
echo "  model: ${MODEL_PATH}"
echo "  log:   ${LOG_FILE}"

cd "${SERVER_DIR}"
LD_LIBRARY_PATH="${SERVER_DIR}" nohup "${SERVER_BIN}" \
  --host "${HOST}" \
  --port "${PORT}" \
  -m "${MODEL_PATH}" \
  -ngl 0 \
  -c 4096 \
  > "${LOG_FILE}" 2>&1 &
SERVER_PID=$!
echo "  pid:   ${SERVER_PID}"

echo -n "waiting for health check "
HEALTHY=0
for _ in $(seq 1 120); do
  BODY="$(curl -s --noproxy '*' "http://${HOST}:${PORT}/health" 2>/dev/null || true)"
  if echo "${BODY}" | grep -q '"status":"ok"'; then
    HEALTHY=1
    break
  fi
  echo -n "."
  sleep 1
done
echo ""

if [[ "${HEALTHY}" -eq 1 ]]; then
  echo "health check: OK"
  curl -s --noproxy '*' "http://${HOST}:${PORT}/health"
  echo ""
  echo "server is up, pid ${SERVER_PID}. Stop it with: kill ${SERVER_PID}"
else
  echo "health check: FAILED after 60s - check ${LOG_FILE}" >&2
  exit 1
fi
