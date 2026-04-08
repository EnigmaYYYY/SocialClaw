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

stop_pidfile_process "$STACK_DIR/visual-monitor.pid" "Visual Monitor API"
stop_pidfile_process "$STACK_DIR/evermemos.pid" "EverMemOS API"
stop_port_processes "$VISUAL_MONITOR_PORT" "Visual Monitor API"
stop_port_processes "$EVERMEMOS_PORT" "EverMemOS API"
