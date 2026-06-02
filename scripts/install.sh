#!/usr/bin/env bash
# omlx-resource-monitor — install script
#
# Installs the monitor sidecar so that browsing to
#   http://127.0.0.1:8443/admin/monitor
# (or wherever your oMLX nginx vhost listens) shows a live resource panel.
#
# What this does:
#   1. Sanity-check the environment (macOS arm64, Python 3, nginx, oMLX, macmon).
#   2. Copy resource_logger.py / panel.js / monitor.html into INSTALL_DIR.
#   3. Render the nginx server block + LaunchAgent plist with absolute paths.
#   4. Install the nginx config and reload nginx.
#   5. Install the LaunchAgent and bootstrap it.
#   6. Make sure macmon is running with --interval 500.
#
# All steps are idempotent — rerunning the script upgrades an existing install.
#
# Run with --help to see flags.

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────
INSTALL_DIR_DEFAULT="$HOME/.local/share/omlx-resource-monitor"
NGINX_SERVERS_DIR_DEFAULT="/opt/homebrew/etc/nginx/servers"
LAUNCH_AGENT_LABEL="com.omlx-resource-monitor"
NGINX_CONF_NAME="omlx-resource-monitor.conf"
MACMON_INTERVAL_MS=500

INSTALL_DIR="${INSTALL_DIR:-$INSTALL_DIR_DEFAULT}"
NGINX_SERVERS_DIR="${NGINX_SERVERS_DIR:-$NGINX_SERVERS_DIR_DEFAULT}"
DRY_RUN=0
ASSUME_YES=0
SKIP_MACMON=0

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/src"
EXAMPLES_DIR="$REPO_ROOT/examples"


# ── Output helpers ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; CYAN=''; GREEN=''; YELLOW=''; RED=''; RESET=''
fi

step() { printf '\n%s>>>%s %s\n' "$CYAN$BOLD" "$RESET$BOLD" "$1$RESET"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '    %s⚠%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '%s✗%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

usage() {
  cat <<EOF
${BOLD}omlx-resource-monitor installer${RESET}

Usage: $(basename "$0") [options]

Options:
  --install-dir <path>     Where to put the runtime files
                           (default: $INSTALL_DIR_DEFAULT)
  --nginx-dir <path>       nginx servers directory
                           (default: $NGINX_SERVERS_DIR_DEFAULT)
  --skip-macmon            Don't try to install/configure macmon
  --dry-run                Show what would happen, change nothing
  -y, --yes                Don't prompt for confirmation
  -h, --help               Show this and exit

Environment variables (alternative to flags):
  INSTALL_DIR, NGINX_SERVERS_DIR

After install, browse to:
  ${CYAN}http://127.0.0.1:8443/admin/monitor${RESET}
EOF
}


# ── Arg parsing ─────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir)   INSTALL_DIR="$2"; shift 2 ;;
    --nginx-dir)     NGINX_SERVERS_DIR="$2"; shift 2 ;;
    --skip-macmon)   SKIP_MACMON=1; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -y|--yes)        ASSUME_YES=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done


# ── Helpers ─────────────────────────────────────────────────────────────────
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    %sdry-run:%s %s\n' "$DIM" "$RESET" "$*"
  else
    "$@"
  fi
}

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  local q="$1"
  printf '%s? %s [y/N]: %s' "$BOLD" "$q" "$RESET"
  read -r reply
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}


# ── Step 1: environment checks ──────────────────────────────────────────────
step "Checking environment"

[ "$(uname)" = "Darwin" ] || die "macOS only — got $(uname)"
[ "$(uname -m)" = "arm64" ] || die "Apple Silicon (arm64) only — got $(uname -m)"
ok "macOS arm64"

if ! command -v python3 >/dev/null 2>&1; then
  die "python3 not found in PATH"
fi
PYTHON_BIN="$(command -v python3)"
PY_VER="$($PYTHON_BIN -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
ok "Python $PY_VER at $PYTHON_BIN"

if ! command -v nginx >/dev/null 2>&1; then
  die "nginx not found. Install with: brew install nginx"
fi
ok "nginx at $(command -v nginx)"

if [ ! -d "$NGINX_SERVERS_DIR" ]; then
  die "nginx servers dir not found: $NGINX_SERVERS_DIR
   (override with --nginx-dir)"
fi
ok "nginx servers dir: $NGINX_SERVERS_DIR"

# oMLX must be running for us to talk to it.
if ! curl -fsS -o /dev/null -m 2 http://127.0.0.1:8000/health 2>/dev/null; then
  warn "oMLX is not responding on http://127.0.0.1:8000 — install will still proceed,"
  warn "but the monitor won't have memory breakdown until oMLX is up."
else
  ok "oMLX is up at http://127.0.0.1:8000"
fi


# ── Step 2: macmon ──────────────────────────────────────────────────────────
if [ "$SKIP_MACMON" -eq 1 ]; then
  step "Skipping macmon setup (--skip-macmon)"
else
  step "Setting up macmon"
  if ! command -v macmon >/dev/null 2>&1; then
    warn "macmon not installed."
    if confirm "Install via Homebrew (brew install macmon)?"; then
      run brew install macmon
    else
      die "macmon is required. Install manually with: brew install macmon"
    fi
  else
    ok "macmon at $(command -v macmon)"
  fi

  # Check if macmon is already serving with the right interval.
  if pgrep -f "macmon serve" >/dev/null 2>&1; then
    CURRENT_ARGS="$(ps -o command= -p "$(pgrep -f 'macmon serve' | head -1)")"
    if echo "$CURRENT_ARGS" | grep -q -- "--interval $MACMON_INTERVAL_MS"; then
      ok "macmon serve already running with --interval $MACMON_INTERVAL_MS"
    else
      warn "macmon is running but not with --interval $MACMON_INTERVAL_MS — restarting it."
      MACMON_PLIST="$HOME/Library/LaunchAgents/com.macmon.plist"
      if [ -f "$MACMON_PLIST" ]; then
        run launchctl bootout "gui/$(id -u)/com.macmon" 2>/dev/null || true
      fi
      run macmon serve --install --port 9090 --interval $MACMON_INTERVAL_MS
    fi
  else
    note "macmon not running — installing as LaunchAgent."
    run macmon serve --install --port 9090 --interval $MACMON_INTERVAL_MS
  fi
fi


# ── Step 3: copy runtime files ──────────────────────────────────────────────
step "Installing runtime files"
note "Install dir: $INSTALL_DIR"
run mkdir -p "$INSTALL_DIR"
run cp "$SRC_DIR/resource_logger.py" "$INSTALL_DIR/resource_logger.py"
run cp "$SRC_DIR/panel.js"           "$INSTALL_DIR/panel.js"
run cp "$SRC_DIR/monitor.html"       "$INSTALL_DIR/monitor.html"
run chmod 0644 "$INSTALL_DIR"/*
ok "Copied 3 files"


# ── Step 4: nginx config ────────────────────────────────────────────────────
step "Configuring nginx"

NGINX_CONF_DEST="$NGINX_SERVERS_DIR/$NGINX_CONF_NAME"
if [ -f "$NGINX_CONF_DEST" ]; then
  # Back up an existing version (timestamped) before overwriting.
  BACKUP="$NGINX_CONF_DEST.bak.$(date +%Y%m%d-%H%M%S)"
  run cp "$NGINX_CONF_DEST" "$BACKUP"
  note "Backed up existing config to: $BACKUP"
fi

# Render the template (substitute __INSTALL_DIR__).
TMPL="$EXAMPLES_DIR/omlx-resource-monitor.conf"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '    %sdry-run:%s sed -e "s,__INSTALL_DIR__,%s,g" %s > %s\n' \
    "$DIM" "$RESET" "$INSTALL_DIR" "$TMPL" "$NGINX_CONF_DEST"
else
  sed -e "s,__INSTALL_DIR__,$INSTALL_DIR,g" "$TMPL" > "$NGINX_CONF_DEST"
fi
ok "Wrote $NGINX_CONF_DEST"

# Validate, then reload.
if [ "$DRY_RUN" -eq 0 ]; then
  if ! nginx -t 2>/dev/null; then
    nginx -t || true
    die "nginx -t failed. Edit $NGINX_CONF_DEST manually and rerun, or restore the backup."
  fi
  ok "nginx -t passed"
  run nginx -s reload
  ok "nginx reloaded"
else
  note "Would run: nginx -t && nginx -s reload"
fi


# ── Step 5: LaunchAgent ─────────────────────────────────────────────────────
step "Installing LaunchAgent ($LAUNCH_AGENT_LABEL)"

LA_DIR="$HOME/Library/LaunchAgents"
LA_PLIST="$LA_DIR/$LAUNCH_AGENT_LABEL.plist"
run mkdir -p "$LA_DIR"

TMPL="$EXAMPLES_DIR/com.omlx-resource-monitor.plist.tmpl"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '    %sdry-run:%s render template → %s\n' "$DIM" "$RESET" "$LA_PLIST"
else
  sed \
    -e "s,__PYTHON_BIN__,$PYTHON_BIN,g" \
    -e "s,__INSTALL_DIR__,$INSTALL_DIR,g" \
    -e "s,__HOME__,$HOME,g" \
    "$TMPL" > "$LA_PLIST"
fi
ok "Wrote $LA_PLIST"

# Bootstrap (or re-bootstrap if already loaded).
if [ "$DRY_RUN" -eq 0 ]; then
  if launchctl print "gui/$(id -u)/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1; then
    note "Existing service detected — reloading."
    launchctl bootout "gui/$(id -u)/$LAUNCH_AGENT_LABEL" 2>/dev/null || true
  fi
  if ! launchctl bootstrap "gui/$(id -u)" "$LA_PLIST" 2>/dev/null; then
    warn "launchctl bootstrap reported a non-zero exit (often benign)."
  fi
  sleep 2
  if launchctl print "gui/$(id -u)/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1; then
    ok "Service is loaded"
  else
    warn "Service is not loaded — check the log at ~/.omlx-resource-monitor.log"
  fi
else
  note "Would run: launchctl bootstrap gui/$(id -u) $LA_PLIST"
fi


# ── Step 6: smoke test ──────────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 0 ]; then
  step "Verifying"
  sleep 1
  if curl -fsS -m 3 -o /dev/null http://127.0.0.1:9091/state; then
    ok "Logger SSE server is up on :9091"
  else
    warn "Logger isn't responding on :9091 yet — give it a few seconds and try again."
  fi
fi


# ── Done ────────────────────────────────────────────────────────────────────
cat <<EOF

${BOLD}${GREEN}Installation complete.${RESET}

Open the monitor:
  ${CYAN}http://127.0.0.1:8443/admin/monitor${RESET}

A "Monitoring" tab will appear in the oMLX admin navbar between Status
and Models. You may need to sign in to /admin first if you don't have
an active session.

Logs:
  Logger:      ~/.omlx-resource-monitor.log
  Archive:     ~/resource-logs/resource.log (+ daily *.log.gz)
  Debug dump:  curl http://127.0.0.1:8443/custom/state | jq

Uninstall:
  $REPO_ROOT/scripts/uninstall.sh
EOF
