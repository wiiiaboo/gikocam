#!/bin/bash
# Runs on the VPS: unpack the uploaded release and (re)build the container.
set -euo pipefail
cd ~
rm -rf gikocam.new && mkdir gikocam.new && tar -xzf /tmp/gikocam.tgz -C gikocam.new
if [ -d gikocam ]; then rm -rf gikocam.old && mv gikocam gikocam.old; fi
mv gikocam.new gikocam
cd gikocam/deploy
docker compose -p gikocam up -d --build
sleep 3
docker ps --filter name=^gikocam$ --format '{{.Names}} {{.Status}}'
docker exec gikocam wget -qO- http://127.0.0.1:8080/health; echo
rm -f /tmp/gikocam.tgz
