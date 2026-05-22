#!/bin/bash
# Mac server-mode setup. Run with: sudo bash mac-server-mode.sh
set -u

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run with sudo: sudo bash $0"
  exit 1
fi

echo "=== PMSET BEFORE ==="
pmset -g custom
echo

echo "=== APPLYING SERVER-MODE SETTINGS ==="
pmset -a sleep 0           && echo "  sleep       -> 0"
pmset -a disksleep 0       && echo "  disksleep   -> 0"
pmset -a autorestart 1     && echo "  autorestart -> 1"
pmset -a tcpkeepalive 1    && echo "  tcpkeepalive-> 1"
pmset -a womp 1            && echo "  womp        -> 1"
systemsetup -setrestartfreeze on 2>&1 | sed 's/^/  /'
systemsetup -setwaitforstartupafterpowerfailure 0 2>&1 | sed 's/^/  /'
echo

echo "=== PMSET AFTER ==="
pmset -g custom
echo

echo "=== SSH ==="
systemsetup -getremotelogin
read -r -p "Enable Remote Login (SSH) now? [y/N] " yn
[[ "$yn" =~ ^[Yy]$ ]] && systemsetup -setremotelogin on && echo "SSH enabled."
echo

echo "=== AUTO-LOGIN ==="
defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>&1 \
  || echo "  no autoLoginUser set"
echo "  -> Enable via System Settings > Users & Groups > Automatic Login."
echo
echo "DONE."
