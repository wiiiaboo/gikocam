#!/bin/bash
# One-time: add cam.gikochan.net to the shared Caddyfile. Runs on the VPS.
set -euo pipefail
CF=/opt/docker-platform/Caddyfile
if sudo grep -q '^cam.gikochan.net' "$CF"; then echo "already present"; exit 0; fi
sudo cp -p "$CF" "$CF.bak-gikocam"
# Append in place (tee -a keeps the inode the caddy container's bind mount uses).
printf '\n# gikocam: phone camera client + signalling relay for gikopoipoi\ncam.gikochan.net {\n  encode zstd gzip\n  reverse_proxy gikocam:8080\n}\n' | sudo tee -a "$CF" > /dev/null
if docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
  docker exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  echo "caddy reloaded"
else
  echo "validation failed, restoring backup"
  sudo cp "$CF.bak-gikocam" /tmp/caddy-restore && sudo tee "$CF" < /tmp/caddy-restore > /dev/null && sudo rm /tmp/caddy-restore
  exit 1
fi
