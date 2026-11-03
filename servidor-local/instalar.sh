#!/usr/bin/env bash
# Instalador del servidor local de Sala (Debian, Ubuntu, Raspberry Pi OS)
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
echo "== Sala · servidor local =="

need=()
command -v ffmpeg >/dev/null || need+=(ffmpeg)
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then need+=(nodejs); fi
if [ ${#need[@]} -gt 0 ]; then
  echo "Instalando: ${need[*]}"
  sudo apt-get update -y
  sudo apt-get install -y "${need[@]}"
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Tu Node es muy viejo. Instala Node 18 o superior (https://nodejs.org) y vuelve a correr este script."; exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^SALA_SECRET=.*|SALA_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 64)|" .env
  echo "Creé el archivo .env con una clave nueva."
fi

SERVICE=/etc/systemd/system/sala-local.service
sudo tee "$SERVICE" >/dev/null <<UNIT
[Unit]
Description=Sala - servidor local de videos
After=network-online.target
Wants=network-online.target

[Service]
User=$(whoami)
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/server.js
Restart=always
RestartSec=5
Nice=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now sala-local
sleep 2
IP=$(hostname -I | awk '{print $1}')
PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-8787}
if curl -fsS "http://localhost:$PORT/api/ping" >/dev/null; then
  echo
  echo "Listo. El servidor está funcionando y arrancará solo al prender el equipo."
  echo "En tu red local abre:  http://$IP:$PORT"
  echo "Ver registros:         journalctl -u sala-local -f"
else
  echo "El servicio no respondió. Revisa con: journalctl -u sala-local -n 50"
fi
