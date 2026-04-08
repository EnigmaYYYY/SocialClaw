#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_DIR="$ROOT_DIR/.socialclaw-stack"
MEMORY_DIR="$ROOT_DIR/memory/evermemos"
FRONTEND_DIR="$ROOT_DIR/social_copilot/frontend"

EVERMEMOS_HOST="${EVERMEMOS_HOST:-127.0.0.1}"
EVERMEMOS_PORT="${EVERMEMOS_PORT:-1995}"
VISUAL_MONITOR_HOST="${VISUAL_MONITOR_HOST:-127.0.0.1}"
VISUAL_MONITOR_PORT="${VISUAL_MONITOR_PORT:-18777}"
MONGODB_HOST="${MONGODB_HOST:-127.0.0.1}"
REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
ES_HOSTS="${ES_HOSTS:-http://127.0.0.1:19200}"
MILVUS_HOST="${MILVUS_HOST:-127.0.0.1}"
DEPENDENCY_TIMEOUT_SEC="${DEPENDENCY_TIMEOUT_SEC:-300}"
STARTUP_POLL_INTERVAL_SEC="${STARTUP_POLL_INTERVAL_SEC:-2}"
DEFAULT_VISUAL_MONITOR_PYTHON="/Applications/miniconda3/envs/social_copilot/bin/python"
if [ -x "$DEFAULT_VISUAL_MONITOR_PYTHON" ]; then
  VISUAL_MONITOR_PYTHON="${VISUAL_MONITOR_PYTHON:-$DEFAULT_VISUAL_MONITOR_PYTHON}"
else
  VISUAL_MONITOR_PYTHON="${VISUAL_MONITOR_PYTHON:-python}"
fi

mkdir -p "$STACK_DIR"

stop_pidfile_process() {
  local pidfile="$1"
  local name="$2"

  if [ ! -f "$pidfile" ]; then
    return 0
  fi

  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    rm -f "$pidfile"
    return 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    echo "Stopping $name from pidfile (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      echo "$name PID $pid did not exit after SIGTERM, forcing shutdown..."
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi

  rm -f "$pidfile"
}

stop_port_processes() {
  local port="$1"
  local name="$2"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return 0
  fi

  echo "Cleaning stale $name listeners on port $port: $pids"
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "Force killing remaining $name listeners on port $port: $pids"
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
}

show_recent_log() {
  local log_file="$1"
  local name="$2"
  if [ -f "$log_file" ]; then
    echo ""
    echo "Recent $name log ($log_file):"
    tail -n 40 "$log_file" || true
  fi
}

wait_for_tcp_ready() {
  local name="$1"
  local host="$2"
  local port="$3"
  local deadline="$4"

  while [ "$(date +%s)" -lt "$deadline" ]; do
    if nc -z "$host" "$port" >/dev/null 2>&1; then
      echo "$name is ready at $host:$port"
      return 0
    fi
    sleep "$STARTUP_POLL_INTERVAL_SEC"
  done

  echo "ERROR: $name did not become ready at $host:$port within ${DEPENDENCY_TIMEOUT_SEC}s."
  return 1
}

wait_for_http_ready() {
  local name="$1"
  local url="$2"
  local deadline="$3"

  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "$name is ready at $url"
      return 0
    fi
    sleep "$STARTUP_POLL_INTERVAL_SEC"
  done

  echo "ERROR: $name did not become ready at $url within ${DEPENDENCY_TIMEOUT_SEC}s."
  return 1
}

echo "[0/3] Restarting managed backend processes..."
stop_pidfile_process "$STACK_DIR/visual-monitor.pid" "Visual Monitor API"
stop_pidfile_process "$STACK_DIR/evermemos.pid" "EverMemOS API"
stop_port_processes "$VISUAL_MONITOR_PORT" "Visual Monitor API"
stop_port_processes "$EVERMEMOS_PORT" "EverMemOS API"

echo "[1/3] Starting EverMemOS Docker dependencies..."
(cd "$MEMORY_DIR" && docker-compose up -d)

dependency_deadline=$(( $(date +%s) + DEPENDENCY_TIMEOUT_SEC ))
wait_for_tcp_ready "MongoDB" "127.0.0.1" "27017" "$dependency_deadline"
wait_for_tcp_ready "Redis" "127.0.0.1" "6379" "$dependency_deadline"
wait_for_tcp_ready "Milvus" "127.0.0.1" "19530" "$dependency_deadline"
wait_for_http_ready "Elasticsearch" "http://127.0.0.1:19200/_cluster/health" "$dependency_deadline"

echo "[2/3] Starting EverMemOS API..."
(
  cd "$MEMORY_DIR"
  nohup env \
    MONGODB_HOST="$MONGODB_HOST" \
    REDIS_HOST="$REDIS_HOST" \
    ES_HOSTS="$ES_HOSTS" \
    MILVUS_HOST="$MILVUS_HOST" \
    uv run python src/run.py --host "$EVERMEMOS_HOST" --port "$EVERMEMOS_PORT" \
    > "$STACK_DIR/evermemos.log" 2>&1 &
  echo $! > "$STACK_DIR/evermemos.pid"
)

evermemos_deadline=$(( $(date +%s) + DEPENDENCY_TIMEOUT_SEC ))
if ! wait_for_http_ready "EverMemOS API" "http://${EVERMEMOS_HOST}:${EVERMEMOS_PORT}/health" "$evermemos_deadline"; then
  show_recent_log "$STACK_DIR/evermemos.log" "EverMemOS API"
  exit 1
fi

echo "[3/3] Starting Visual Monitor API..."
(
  cd "$ROOT_DIR"
  nohup "$VISUAL_MONITOR_PYTHON" -m uvicorn social_copilot.visual_monitor.app:app \
    --host "$VISUAL_MONITOR_HOST" --port "$VISUAL_MONITOR_PORT" \
    > "$STACK_DIR/visual-monitor.log" 2>&1 &
  echo $! > "$STACK_DIR/visual-monitor.pid"
)

visual_monitor_deadline=$(( $(date +%s) + DEPENDENCY_TIMEOUT_SEC ))
if ! wait_for_http_ready "Visual Monitor API" "http://${VISUAL_MONITOR_HOST}:${VISUAL_MONITOR_PORT}/health" "$visual_monitor_deadline"; then
  show_recent_log "$STACK_DIR/visual-monitor.log" "Visual Monitor API"
  exit 1
fi

RESOLVED_VLM_TIMEOUT="$(curl -sf "http://${VISUAL_MONITOR_HOST}:${VISUAL_MONITOR_PORT}/monitor/config" 2>/dev/null \
  | python -c 'import json,sys
try:
    payload=json.load(sys.stdin)
    print(payload["monitor"]["vision"]["litellm"]["timeout_ms"])
except Exception:
    pass' 2>/dev/null || true)"

cat <<EOF

Backend services started.

Logs:
- $STACK_DIR/evermemos.log
- $STACK_DIR/visual-monitor.log

Resolved Visual Monitor config:
- vision timeout_ms: ${RESOLVED_VLM_TIMEOUT:-unavailable}

Note:
- Both API servers passed health checks before this script returned.
- Actual monitoring remains idle until the frontend triggers monitoring or you call:
  curl -X POST http://${VISUAL_MONITOR_HOST}:${VISUAL_MONITOR_PORT}/monitor/start

Next step:
cd "$FRONTEND_DIR"
npm install
npm run dev
EOF
