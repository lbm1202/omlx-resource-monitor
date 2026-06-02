#!/usr/bin/env bash
# omlx-resource-monitor — uninstall script
#
# Removes everything install.sh added:
#   - LaunchAgent (com.omlx-resource-monitor)
#   - nginx config (omlx-resource-monitor.conf)
#   - Install directory (runtime files)
#
# Optionally:
#   --keep-logs    don't delete ~/resource-logs/
#   --keep-macmon  leave macmon's LaunchAgent in place (default)
#   --purge-macmon also unload macmon's LaunchAgent

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/omlx-resource-monitor}"
NGINX_SERVERS_DIR="${NGINX_SERVERS_DIR:-/opt/homebrew/etc/nginx/servers}"
LAUNCH_AGENT_LABEL="com.omlx-resource-monitor"
NGINX_CONF_NAME="omlx-resource-monitor.conf"

KEEP_LOGS=1                   # default: keep historical logs
PURGE_MACMON=0
ASSUME_YES=0

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; CYAN=''; GREEN=''; YELLOW=''; RED=''; RESET=''
fi

step() { printf '\n%s>>>%s %s\n' "$CYAN$BOLD" "$RESET$BOLD" "$1$RESET"; }
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '    %s⚠%s %s\n' "$YELLOW" "$RESET" "$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir)   INSTALL_DIR="$2"; shift 2 ;;
    --nginx-dir)     NGINX_SERVERS_DIR="$2"; shift 2 ;;
    --drop-logs)     KEEP_LOGS=0; shift ;;
    --purge-macmon)  PURGE_MACMON=1; shift ;;
    -y|--yes)        ASSUME_YES=1; shift ;;
    -h|--help)
      cat <<EOF
${BOLD}omlx-resource-monitor uninstaller${RESET}

Usage: $(basename "$0") [options]

Options:
  --install-dir <path>   Override install directory
  --nginx-dir <path>     Override nginx servers directory
  --drop-logs            Also remove ~/resource-logs/ (default: keep)
  --purge-macmon         Also remove macmon's LaunchAgent (default: keep)
  -y, --yes              Don't prompt
  -h, --help             Show this and exit
EOF
      exit 0 ;;
    *) printf '%sunknown option: %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1 ;;
  esac
done

if [ "$ASSUME_YES" -ne 1 ]; then
  printf '%sUninstall omlx-resource-monitor?%s [y/N]: ' "$BOLD" "$RESET"
  read -r reply
  case "$reply" in y|Y|yes|YES) : ;; *) echo "aborted"; exit 0 ;; esac
fi


step "Stopping LaunchAgent"
if launchctl print "gui/$(id -u)/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LAUNCH_AGENT_LABEL" 2>/dev/null || true
  ok "Bootout sent"
else
  warn "Was not running"
fi

LA_PLIST="$HOME/Library/LaunchAgents/$LAUNCH_AGENT_LABEL.plist"
if [ -f "$LA_PLIST" ]; then
  rm -f "$LA_PLIST"
  ok "Removed $LA_PLIST"
fi


step "Removing nginx config"
NGINX_CONF="$NGINX_SERVERS_DIR/$NGINX_CONF_NAME"
if [ -f "$NGINX_CONF" ]; then
  rm -f "$NGINX_CONF"
  ok "Removed $NGINX_CONF"
  if command -v nginx >/dev/null 2>&1 && nginx -t 2>/dev/null; then
    nginx -s reload 2>/dev/null || true
    ok "nginx reloaded"
  fi
else
  warn "nginx config not found ($NGINX_CONF)"
fi


step "Removing runtime files"
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  ok "Removed $INSTALL_DIR"
else
  warn "Install dir not found ($INSTALL_DIR)"
fi


if [ "$KEEP_LOGS" -eq 0 ]; then
  step "Removing historical logs"
  if [ -d "$HOME/resource-logs" ]; then
    rm -rf "$HOME/resource-logs"
    ok "Removed ~/resource-logs"
  fi
else
  step "Keeping ~/resource-logs/ (use --drop-logs to remove)"
fi

if [ -f "$HOME/.omlx-resource-monitor.log" ]; then
  rm -f "$HOME/.omlx-resource-monitor.log"
fi


if [ "$PURGE_MACMON" -eq 1 ]; then
  step "Removing macmon LaunchAgent"
  launchctl bootout "gui/$(id -u)/com.macmon" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.macmon.plist"
  ok "macmon LaunchAgent removed (the brew formula is still installed)"
fi


printf '\n%s%sUninstall complete.%s\n' "$BOLD" "$GREEN" "$RESET"
