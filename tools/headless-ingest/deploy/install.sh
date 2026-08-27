#!/usr/bin/env bash
# install.sh — deploy llm_wiki as headless ingest + real web UI on a Linux VPS.
# VPS-optimized: no desktop webview. The SPA renders in the browser; the VPS
# runs a thin Bun backend + a CPU-capped headless ingest engine.
#
# Usage:
#   VAULT=/home/USER/mybrain UI_PASSWORD='choose-a-strong-one' \
#   HOST=<tailnet-or-loopback-ip> PORT=19850 \
#   OPENROUTER_KEY='sk-or-v1-...' bash install.sh
#
# Re-runnable (idempotent). Preserves an existing vault + ingest queue.
set -euo pipefail

FORK="$(cd "$(dirname "$0")/../../.." && pwd)"   # repo root
USER_NAME="$(id -un)"
VAULT="${VAULT:?set VAULT=/abs/path/to/vault}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-19850}"
UI_PASSWORD="${UI_PASSWORD:-}"
OPENROUTER_KEY="${OPENROUTER_KEY:-}"
SYS="$HOME/.config/systemd/user"
BUN="$(command -v bun || echo "$HOME/.local/bin/bun")"

# --- fail closed: a network bind MUST have a password ---
case "$HOST" in
  127.0.0.1|localhost|::1) ;;                     # loopback: password optional
  *) [ -n "$UI_PASSWORD" ] || { echo "ERROR: non-loopback HOST needs UI_PASSWORD"; exit 1; } ;;
esac

echo "==> prereqs"
for c in "$BUN" node ffmpeg rg git; do command -v "$c" >/dev/null || { echo "missing: $c"; exit 1; }; done

echo "==> deps + web build"
cd "$FORK"
npm install --no-audit --no-fund >/dev/null
npm run build:web >/dev/null
echo "    web/dist built"

echo "==> ownership (engine must own the vault)"
if [ -n "$(find "$VAULT" ! -user "$USER_NAME" -print -quit 2>/dev/null)" ]; then
  echo "    WARNING: files in $VAULT are not owned by $USER_NAME."
  echo "    Run once as root:  sudo chown -R $USER_NAME:$USER_NAME $VAULT"
fi

echo "==> systemd --user units"
mkdir -p "$SYS" "$HOME/.config/llm-wiki-ui"
loopback=false; case "$HOST" in 127.0.0.1|localhost|::1) loopback=true;; esac

# UI env (600 — holds the password + keys)
cat > "$HOME/.config/llm-wiki-ui/env" <<EOF
VAULT=$VAULT
HOST=$HOST
PORT=$PORT
UI_ZOOM=1
UI_PASSWORD=$UI_PASSWORD
AGENT_CLAUDE_BIN=$HOME/.local/bin/claude
AGENT_CODEX_BIN=$(command -v codex 2>/dev/null || echo /usr/bin/codex)
EOF
chmod 600 "$HOME/.config/llm-wiki-ui/env"

gen_unit() { # name  desc  host  port  extra-env-line
  cat > "$SYS/$1.service" <<EOF
[Unit]
Description=$2
[Service]
EnvironmentFile=$HOME/.config/llm-wiki-ui/env
Environment=HOST=$3
Environment=PORT=$4
$5
WorkingDirectory=$FORK
ExecStart=$BUN --smol tools/headless-ingest/light-backend.ts
Restart=on-failure
MemoryMax=256M
[Install]
WantedBy=default.target
EOF
}
gen_unit llm-wiki-ui "llm_wiki web UI (password-gated)" "$HOST" "$PORT" ""
# Loopback MCP backend must NOT inherit UI_PASSWORD (later Environment= wins over
# the EnvironmentFile), else /api/v1 would 401 and break the MCP proxy.
gen_unit llm-wiki-light-backend "llm_wiki MCP backend (loopback)" "127.0.0.1" "19829" "Environment=UI_PASSWORD="

# ingest engine (drain-only, CPU-capped, resumes the queue)
cat > "$SYS/llm-wiki-ingest-ui.service" <<EOF
[Unit]
Description=llm_wiki headless ingest (drain-only, CPU-capped)
[Service]
Type=oneshot
EnvironmentFile=$HOME/.config/llm-wiki-ui/env
WorkingDirectory=$FORK
ExecStart=$BUN --smol --preload tools/headless-ingest/preload.ts tools/headless-ingest/run.ts --project $VAULT --config $VAULT/.llm-wiki/app-state.json --concurrency 1 --max-size 25M
CPUQuota=60%
MemoryMax=700M
Nice=15
IOSchedulingClass=idle
TimeoutStartSec=1800
EOF

loginctl enable-linger "$USER_NAME" >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable --now llm-wiki-light-backend.service llm-wiki-ui.service >/dev/null 2>&1 || true

echo "==> seed config ($VAULT/.llm-wiki/app-state.json) — PRESERVES an existing one"
mkdir -p "$VAULT/.llm-wiki"
if [ ! -f "$VAULT/.llm-wiki/app-state.json" ]; then
  cat > "$VAULT/.llm-wiki/app-state.json" <<EOF
{
  "llmConfig": { "provider": "custom", "apiKey": "$OPENROUTER_KEY", "model": "deepseek/deepseek-chat-v3-0324", "customEndpoint": "https://openrouter.ai/api/v1", "apiMode": "chat_completions", "streamingEnabled": true, "maxContextSize": 128000 },
  "embeddingConfig": { "enabled": true, "endpoint": "https://openrouter.ai/api/v1/embeddings", "apiKey": "$OPENROUTER_KEY", "model": "voyageai/voyage-4-lite" }
}
EOF
  echo "    seeded (set MinerU token + Groq key + vision model in the web Settings)"
else
  echo "    kept existing config + ingest queue (resume-safe)"
fi

cat <<EOF

==> DONE.  UI: http://$HOST:$PORT/   (login with UI_PASSWORD)
Next (in the web Settings, or app-state.json):
  - MinerU token         → PDF parsing
  - Groq key + audio on  → audio/video transcription
  - vision model         → image captions (e.g. google/gemini-2.5-flash-lite)
  - Web Search provider + key (Exa/Tavily/...)
MCP tunnel (optional): point a cloudflared tunnel at 127.0.0.1:8932.
Ingest resumes automatically from $VAULT/.llm-wiki/ingest-queue.json (done files skipped).
EOF
